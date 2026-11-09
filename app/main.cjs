const { app, BrowserWindow, ipcMain, dialog, Menu, clipboard, nativeImage, session, shell, screen, Notification } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ensureService, connect, connectService, continuationStatus, continueService } = require('./service-client.cjs');
const backendSwitch = require('./backend-switch.cjs');
const { startDsh, resetUiAuthentication } = require('./dsh-host.cjs');
const { startupMessage, uiError } = require('./ui-errors.cjs');
const uiLocale = require('./ui-locale.js');
const { preflight, appBuildInfo } = require('./preflight.cjs');
const { setLocation } = require('./runtime-locations.cjs');
const { pathToFileURL } = require('node:url');
const { submissionState, assertNativeCreation, capabilitiesFor } = require('./submission-policy.cjs');
const { readPreview, saveCopy, extensions: textExtensions, openMessageFile } = require('./local-files.cjs');
const { ImagePreviews, imageSource } = require('./native-images.cjs');
const { SessionLabels } = require('./session-labels.cjs');
const { RoomState } = require('./room-state.cjs');
const { readingState } = require('./reading-state.cjs');
const { ViewStore, validViews, dropRetiredViewFields } = require('./view-store.cjs');
const { roomId: validRoomId } = require('./collaboration-spaces.cjs');
const { identity: roomPeerIdentity } = require('./peer-handoffs.cjs');
const { windowPlacement } = require('./window-placement.cjs');
const { backups, beginDraft, acknowledgeDraft, acceptSentDraft, forgetDraft, retainRecovery, discardRecovery } = require('./view-drafts.cjs');
const { createOutboxBroker } = require('./computer-use-outbox-broker.cjs');
const { bindOriginalOutbox, bindClaudeOutbox, bindOriginalControl, bindClaudeControl } = require('./computer-use-outbox-owner.cjs');
const { createStockOutboxView } = require('./computer-use-outbox-view.cjs');
const background = require('./background-control.cjs');
const backgroundOperation = require('./background-operation.cjs');
const queueRules = require('./queue-dispatch.cjs');
const { QueueDispatcher } = queueRules;
const applicationHandlers = new Map();
let backgroundControl, backgroundUnavailable = false;
let outboxBroker, outboxUnavailable = false, outboxClosing = false, outboxQuitFailed = false;

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
// NAW_TEST_VISIBLE=1 keeps every isolation check but shows the test window
// without taking focus, so a person can watch it close and reopen.
const visibleTest = backgroundTest && process.env.NAW_TEST_VISIBLE === '1';
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
const capacityNotifications = new Map();
let entry, dsh;
const trusted = url => { try { const parsed = new URL(url); return parsed.origin === dsh.origin && parsed.pathname === '/'; } catch { return false; } };
let dataDir, sessionLabels, roomState, viewStore, viewStorageWarning = null, viewStorageWarningUiMessage = null, views = [], quitting = false;
let startupWindow, starting = false, wired = false;
let applicationBuild, applicationMenu;
const startupFile = path.join(__dirname, 'startup.html');
let localeSnapshot = uiLocale.snapshot({ languages: [], preference: null });
let localeProvisional, localeWarning = null, localeHostGeneration = 0;
const displayLanguage = () => localeProvisional || uiLocale.language(localeSnapshot);
const displayText = (key, params) => uiLocale.format(displayLanguage(), key, params);
function broadcastLocale() {
  const targets = new Set([startupWindow, ...[...windows.values()].map(c => c.win)]);
  for (const win of targets) if (win && !win.isDestroyed()) win.webContents.send('workspace:locale', { ...localeSnapshot, startupLanguage: localeProvisional, warning: localeWarning });
}
async function readStartupLocale() {
  let languages = localeSnapshot.languages;
  try { const value = app.getPreferredSystemLanguages(); if (Array.isArray(value) && value.every(item => typeof item === 'string')) languages = value; } catch {}
  let profile;
  try {
    const { readLocaleProfile } = await import('./ui-locale-profile.mjs');
    profile = await readLocaleProfile({ dataDir: path.join(app.getPath('userData'), 'dsh'), localeModule: require.resolve('@deepseek-ai/dsh-client-locale') });
  } catch { profile = { warning: 'unavailable' }; }
  localeSnapshot = uiLocale.snapshot({ languages, preference: profile.warning ? localeSnapshot.preference : profile.preference }, localeSnapshot);
  localeProvisional = profile.legacyChinese ? 'zh' : undefined;
  localeWarning = profile.warning || null;
  updateApplicationMenu(); broadcastLocale();
}
function acceptLocale(value, generation) {
  if (generation !== localeHostGeneration || quitting) return;
  if (Object.hasOwn(value, 'preference') && uiLocale.validPreference(value.preference)) {
    localeSnapshot = uiLocale.snapshot({ languages: localeSnapshot.languages, preference: value.preference });
    localeProvisional = undefined;
  }
  localeWarning = ['unavailable', 'migrationNotSaved'].includes(value.warning) ? value.warning : null;
  updateApplicationMenu(); broadcastLocale();
}
function workspaceMenuReady() { return Boolean(wired && dsh && entry && dataDir && viewStore?.loaded && !starting && !quitting && !startupWindow); }
function updateApplicationMenu() {
  const text = key => displayText(key, { app: app.name });
  const create = !applicationMenu;
  const menu = applicationMenu ||= Menu.buildFromTemplate([
    { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { id: 'naw-menu-quit', label: text('menu.quit'), accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }] },
    { id: 'naw-menu-file', label: text('menu.file'), submenu: [{ id: 'naw-menu-new-window', label: text('menu.newWindow'), accelerator: 'CmdOrCtrl+Shift+N', click: () => { if (workspaceMenuReady()) return openWindow(); } }, { id: 'naw-menu-new-session', label: text('menu.newSession'), accelerator: 'CmdOrCtrl+N', click: () => { if (!workspaceMenuReady()) return; const win = BrowserWindow.getFocusedWindow(); if (win && windows.get(win.webContents.id)?.win === win) win.webContents.send('workspace:new'); } }, { role: 'close' }] },
    { role: 'editMenu' }, { id: 'naw-menu-view', label: text('menu.view'), submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] }, { role: 'windowMenu' },
  ]);
  // Keep Electron's generated actions/accelerators and native window/Services
  // contents. Relabel only known application-owned standard role labels.
  const roles = { about: 'about', hide: 'hide', hideothers: 'hideOthers', unhide: 'unhide', close: 'close', editmenu: 'edit', undo: 'undo', redo: 'redo', cut: 'cut', copy: 'copy', paste: 'paste', pasteandmatchstyle: 'pasteAndMatchStyle', delete: 'delete', selectall: 'selectAll', reload: 'reload', forcereload: 'forceReload', resetzoom: 'resetZoom', zoomin: 'zoomIn', zoomout: 'zoomOut', togglefullscreen: 'togglefullscreen', windowmenu: 'window', minimize: 'minimize', zoom: 'zoom', front: 'front', services: 'services', speech: 'speech', startspeaking: 'startSpeaking', stopspeaking: 'stopSpeaking' };
  const own = { 'naw-menu-quit': 'quit', 'naw-menu-file': 'file', 'naw-menu-new-window': 'newWindow', 'naw-menu-new-session': 'newSession', 'naw-menu-view': 'view' };
  const relabel = current => { for (const item of current.items || []) { const role = item.role?.toLowerCase(); const key = Object.hasOwn(own, item.id) ? own[item.id] : Object.hasOwn(roles, role) ? roles[role] : undefined; if (key) item.label = text(`menu.${key}`); if (['naw-menu-new-window', 'naw-menu-new-session'].includes(item.id)) item.enabled = workspaceMenuReady(); if (item.submenu) relabel(item.submenu); } };
  relabel(menu); if (create) Menu.setApplicationMenu(menu);
}

function windowOptions(view = {}) { return { title: 'Native Agent Workspace', width: 1240, height: 850, ...view.bounds, show: !backgroundTest && !backgroundLaunch, focusable: !backgroundTest, minWidth: Math.min(850, view.bounds?.width || 850), minHeight: Math.min(600, view.bounds?.height || 600), backgroundColor: '#f8f8f5', webPreferences: { additionalArguments: [`--naw-ui-locale=${JSON.stringify({ ...localeSnapshot, startupLanguage: localeProvisional })}`], ...(backgroundTest ? { backgroundThrottling: false } : {}), preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false } }; }
function createWindow(view) {
  const win = new BrowserWindow(windowOptions(view));
  if (visibleTest) win.once('ready-to-show', () => win.showInactive());
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
      const notification = record.notification = new Notification({ title: displayText('os.toolWaitTitle'), body: displayText('os.toolWaitBody') });
      // A notification is an observation of that past turn, never a session-only
      // interrupt action that could accidentally target its replacement.
      notification.once('click', () => { if (!win.isDestroyed()) win.show(); else if (!quitting) focusOrOpen(); });
      notification.once('close', () => { if (record.notification === notification) delete record.notification; });
      notification.show();
    } catch { /* The existing in-app status remains available if OS delivery fails. */ }
  }
}
function notifyCapacity(snapshot, win) {
  if (win.isDestroyed()) return;
  for (const s of snapshot.sessions || []) {
    const recovery = s.capacityRecovery;
    if (typeof s.id !== 'string' || !s.id || typeof s.nativeId !== 'string' || !s.nativeId ||
        s.archived || s.backendUnavailable || s.transportDisconnected || s.nativeContextPending ||
        s.approval || s.approvalOverflow || s.claudeQuestion || s.nativeApproval || s.nativeInputRequired ||
        !['idle', 'error'].includes(s.state) || recovery?.nativeId !== s.nativeId ||
        typeof recovery.turnId !== 'string' || !recovery.turnId || recovery.status !== 'exhausted' ||
        recovery.attempt !== 3 || !['capacity', 'routing'].includes(recovery.reason)) continue;
    const key = JSON.stringify([recovery.nativeId, recovery.turnId]);
    let notices = capacityNotifications.get(s.id);
    if (!notices) capacityNotifications.set(s.id, notices = { seen: new Set(), active: new Set() });
    if (notices.seen.has(key)) continue;
    // Remember the episode before delivery: repeated or delayed state snapshots
    // must never retry an unsupported/failed OS notification or replay an alert.
    notices.seen.add(key);
    let notification;
    try {
      if (!Notification.isSupported()) continue;
      notification = new Notification({ title: displayText('os.capacityTitle'), body: displayText('os.capacityBody') });
      notices.active.add(notification);
      notification.once('close', () => notices.active.delete(notification));
      notification.once('click', () => { if (!win.isDestroyed()) win.show(); else if (!quitting) focusOrOpen(); });
      notification.show();
    } catch {
      if (notification) notices.active.delete(notification);
      // The original sidebar status remains available without OS delivery.
    }
  }
}
function bindClient(context) {
  const { win, client } = context;
  if (client.control?.legacyInput) client.control.legacyInput.restrictedOutboxCall = (proof, signal) => {
    if (!outboxBroker) throw Object.assign(Error('Restricted outbox is unavailable'), { notSent: true });
    return outboxBroker.submitAuthenticated(abort => bindClaudeOutbox({ contexts: () => windows.values(), roomState }, proof, abort), signal);
  };
  if (client.control?.legacyInput) client.control.legacyInput.backgroundControlCall = (proof, signal) => {
    if (!outboxBroker) throw Error('Background control is unavailable');
    return outboxBroker.submitControlAuthenticated(abort => bindClaudeControl({ contexts: () => windows.values(), roomState }, proof, abort), signal);
  };
  // Rechecked by the router after awaited pauses as well as at IPC entry.
  // A task already accepted natively is not retroactively cancelled.
  client.authorizeOperation = (method, args, roomId = 'shared') => {
    if (context.background) backgroundOperation.assertDeliveryPolicy(client.snapshot(), method, args);
    // The person working in a session keeps queued NAW work out of it for a while.
    else if (HUMAN_SESSION_METHODS.has(method) && typeof args[0] === 'string' && !terminalReplyOnly(method, args)) queueDispatcher?.noteHuman(args[0]);
    if (['send', 'queue', 'queueShared', 'steerShared', 'steer', 'forward', 'run', 'input', 'claim', 'terminal', 'approve', 'answer', 'draft', 'resume'].includes(method)) {
      for (const id of (method === 'run' && Array.isArray(args[0]) ? args[0] : [args[0]])) roomState.assertAvailable(id, ['forward', 'queueShared', 'steerShared', 'run'].includes(method), roomId);
    }
  };
  const send = (channel, ...data) => { if (context.client === client && !win.isDestroyed()) win.webContents.send(channel, ...data); };
  client.on('state', data => { if (context.client === client && !win.isDestroyed()) {
    const display = displayState(data, context);
    send('workspace:state', display); if (!context.background) { notifyToolWait(data, win); notifyCapacity(display, win); }
  } });
  client.on('terminal', data => send('workspace:terminal', data));
  client.on('progress', data => send('workspace:progress', data));
  client.on('closed', () => { if (context.client === client) { const notice = uiError('error.warning.serviceDisconnected'); send('workspace:disconnected', notice.message, notice.uiMessage); } });
}
function displayState(snapshot, context) {
  const roomId = context?.view?.spaceId || 'shared';
  const display = roomState.apply(sessionLabels.apply(submissionState(snapshot)), roomId);
  display.sessions = display.sessions.map(s => ({ ...s }));
  if (backgroundControl) for (const s of display.sessions) {
    const rows = backgroundControl.rows(s.id);
    if (rows.length) s.messages = [...s.messages, ...rows].sort((a, b) => a.time - b.time);
    if (context?.background) {
      s.liveDraft = ''; s.draft = '';
      if (s.id !== context.view.selected) s.messages = [];
    }
  }
  const outboxWarning = backgroundUnavailable ? 'Background control is unavailable; existing native sessions and ordinary controls remain available.' : outboxQuitFailed ? 'Outbox cleanup could not be confirmed. Quit again to close the app; native sessions keep running.'
    : outboxUnavailable ? 'The independent space outbox is unavailable; new delivery cannot be confirmed.' : '';
  return { ...display, ...(outboxWarning ? { storageWarning: [display.storageWarning, outboxWarning].filter(Boolean).join('\n'), storageWarningUiMessage: null } : {}), sessions: display.sessions.map(s => ({ ...s, peerIdentity: roomPeerIdentity(s, roomId), sharedActivity: s.sharedActivities?.[roomId] || (roomId === 'shared' ? s.sharedActivity : null) })), viewStorageWarning, viewStorageWarningUiMessage,
    switchEnded: endedByMove(display.sessions), rotationChains: queueDispatcher ? queueDispatcher.rotationChains() : [] };
}
function reportViewStorage(warning, uiMessage = null) {
  if (viewStorageWarning === warning) return;
  viewStorageWarning = warning; viewStorageWarningUiMessage = uiMessage;
  for (const { win } of windows.values()) if (!win.isDestroyed()) win.webContents.send('workspace:view-storage', warning, uiMessage);
}
// Space task queues: NAW sends each idle member its next item (queue-dispatch.cjs).
let queueDispatcher = null;
const HUMAN_SESSION_METHODS = new Set(['prepareInput', 'input', 'draft', 'send', 'queue', 'steer', 'claim', 'terminal', 'interrupt', 'approve', 'answer', 'forward', 'queueShared', 'steerShared']);
// A terminal's own replies (focus, cursor reports) are not the person typing.
function terminalReplyOnly(method, args) {
  return method === 'input' && queueRules.terminalReplyOnly(args[1]);
}
async function startQueueDispatcher() {
  if (queueDispatcher || process.env.NAW_QUEUE_DISPATCH === 'off') {
    return;
  }
  try {
    const options = {
      roomState,
      dataDir,
      // Prefer a window's client: its state is already held and kept current.
      clients: () => {
        for (const context of windows.values()) {
          const usable = !context.background && !context.win.isDestroyed() && !context.client.closing && !context.client.socket.destroyed;
          if (usable) {
            return context.client;
          }
        }
        return null;
      },
      connect: owner => connect(dataDir, owner),
      labels: sessionLabels.labels,
      broadcast: broadcastRoom,
      notify: notifyRotation,
    };
    // Only a verified isolated test run may shorten the rotation age, lower the memory limit
    // (and the age a session needs before a memory rotation) or the quiet time after the person's input.
    const testRotation = Number(process.env.NAW_TEST_QUEUE_ROTATE_MS);
    if (backgroundTest && Number.isSafeInteger(testRotation) && testRotation > 0) {
      options.rotateAfterMs = testRotation;
    }
    const testMemory = Number(process.env.NAW_TEST_QUEUE_MEMORY_MB);
    if (backgroundTest && Number.isSafeInteger(testMemory) && testMemory > 0) {
      options.memoryLimit = testMemory * 1024 * 1024;
      options.pressureLimit = testMemory * 1024 * 1024;
    }
    const testMemoryAge = Number(process.env.NAW_TEST_QUEUE_MEMORY_MIN_AGE_MS);
    if (backgroundTest && Number.isSafeInteger(testMemoryAge) && testMemoryAge >= 0) {
      options.memoryMinAgeMs = testMemoryAge;
    }
    const testQuiet = Number(process.env.NAW_TEST_QUEUE_HUMAN_QUIET_MS);
    if (backgroundTest && Number.isSafeInteger(testQuiet) && testQuiet >= 0) {
      options.humanQuietMs = testQuiet;
    }
    queueDispatcher = await new QueueDispatcher(options).start();
  } catch {
    // Optional: the app and every native session keep working without it.
    queueDispatcher = null;
  }
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
    if (!viewStore) throw uiError("error.main.viewRecordUnread");
    viewStore.save(views);
    reportViewStorage(null);
    resolve?.();
  } catch (error) {
    const warning = uiError('error.warning.viewSave'); reportViewStorage(warning.message, warning.uiMessage);
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
  catch (error) { if (quitting || win.isDestroyed()) return; throw new Error(startupMessage(error, displayLanguage())); }
  finally { clearTimeout(context.readyTimer); }
  return win;
}
function hasSavedSpaceDraft(records, targetId) {
  return Boolean(targetId && records.some(view => view.roomViews?.[targetId]?.sharedDraft || view.roomViews?.[targetId]?.roomImages?.length || view.spaceId === targetId && view.sharedDraft));
}
function updateSpaceImageDraft(c, roomId, action, value, expectedVersion) {
  roomState.writable(roomId);
  if (!['stageImages', 'removeImage'].includes(action)) throw uiError('error.roomImages.changed');
  const images = require('./space-images.cjs'), previous = c.view.roomViews, view = previous?.[roomId] || {}, existing = view.roomImages || [];
  if (expectedVersion !== view.roomImageVersion) throw uiError('error.roomImages.changed');
  let added;
  try {
    let refs;
    if (action === 'stageImages') {
      if (!Array.isArray(value) || existing.length + value.length > 4) throw uiError('error.roomImages.limit');
      added = images.stageSpaceImages(dataDir, roomId, value, nativeImage);
      refs = [...existing, ...added];
      if (refs.reduce((n, ref) => n + ref.size, 0) > 20 * 1024 * 1024) throw uiError('error.roomImages.limit');
    } else {
      if (!existing.some(ref => ref.id === value)) throw uiError('error.roomImages.changed');
      refs = existing.filter(ref => ref.id !== value);
    }
    const version = randomUUID();
    c.view.roomViews = { ...previous, [roomId]: { ...view, roomImages: refs, roomImageVersion: version } };
    delete c.view.roomViews[roomId].roomImageSend;
    saveViews();
    return { refs, version };
  } catch (error) {
    c.view.roomViews = previous;
    if (added) images.discardStagedSpaceImages(dataDir, roomId, added);
    if (error.uiMessage?.key === 'error.images.sessionCacheLimit') throw uiError('error.roomImages.cacheLimit');
    throw error.uiMessage ? error : uiError('error.roomImages.import');
  }
}
function spaceImageCaptionProof(view) {
  if (!Number.isSafeInteger(view.draftRevision) || view.draftRevision < 0 || view.draftRevision >= Number.MAX_SAFE_INTEGER || typeof view.sharedDraft !== 'string') return null;
  const mention = view.roomMention;
  const caption = [view.sharedDraft, view.roomRecipient, mention ? [mention.id, mention.start, mention.end, mention.text, mention.active, mention.memberRevision] : null];
  return { revision: view.draftRevision, digest: require('node:crypto').createHash('sha256').update(JSON.stringify(caption)).digest('hex') };
}
async function forwardSpaceImages(c, roomId, args) {
  const request = args[4], version = request?.version;
  if (!request || Object.keys(request).length !== 1 || !Object.hasOwn(request, 'version')) throw uiError('error.roomImages.changed');
  const checkDraft = () => {
    const view = c.view.roomViews?.[roomId];
    if (!view?.roomImages?.length || view.roomImageVersion !== version) throw uiError('error.roomImages.changed');
    if (view.roomImageSend?.version === version) throw uiError('error.roomImages.alreadySent');
    return view;
  };
  checkDraft();
  const snapshot = await c.client.call('initial');
  roomState.assertAvailable(args[0], true, roomId);
  const view = checkDraft(), recipient = snapshot.sessions.find(s => s.id === args[0]);
  if (!recipient || recipient.nativeId !== args[2] || !recipient.spaceImagesAvailable || !recipient.serviceCapabilities?.includes('spaceImageInputV1') ||
      recipient.state !== 'idle' || recipient.pendingTag || recipient.pendingQueue || recipient.approval || recipient.nativeInputRequired || snapshot.storageWarning) throw uiError('error.roomImages.deliveryUnavailable');
  // Validate local pixels before reserving the draft; no paths come from renderer.
  const images = require('./space-images.cjs');
  for (const ref of view.roomImages) images.readSpaceImage(dataDir, roomId, ref);
  const previous = c.view.roomViews, send = { version, recipientId: recipient.id, nativeId: recipient.nativeId };
  // Preserve only a fingerprint of the saved caption, never a second text copy.
  const captionProof = spaceImageCaptionProof(view);
  if (captionProof && view.roomRecipient === args[0] && require('./room-mention.js').body(view.roomMention, view.sharedDraft) === args[1]) send.captionProof = captionProof;
  c.view.roomViews = { ...previous, [roomId]: { ...view, roomImageSend: send } };
  try { saveViews(); } catch (error) { c.view.roomViews = previous; throw error; }
  // An interrupted/unknown request remains reserved on disk, never auto-retried.
  const result = await c.client.callSpace(roomId, 'forward', [...args.slice(0, 4), { version, refs: view.roomImages }]);
  const draft = result?.imageReceipt?.status === 'accepted' ? await acceptSpaceImageDraft(c, roomId, version, result.tag) : null;
  return { ...result, ...(draft ? { imageDraft: draft } : {}) };
}
async function acceptSpaceImageDraft(c, roomId, version, tag) {
  const snapshot = await c.client.call('initial'), view = c.view.roomViews?.[roomId], sent = view?.roomImageSend;
  if (snapshot.storageWarning || !sent || view.roomImageVersion !== version || sent.version !== version) return { accepted: false };
  const room = (snapshot.rooms || [snapshot.room]).find(r => (r?.id || 'shared') === roomId), row = room?.messages?.find(m => m.id === tag), receipt = row?.imageReceipt;
  if (!row || row.imageDraftVersion !== version || row.recipientId !== sent.recipientId || JSON.stringify(row.images) !== JSON.stringify(view.roomImages) ||
      receipt?.status !== 'accepted' || receipt.basis !== 'native-local-image-echo' || receipt.tag !== tag || receipt.nativeId !== sent.nativeId ||
      receipt.recipientId !== sent.recipientId || typeof receipt.nativeItemId !== 'string' || !receipt.nativeItemId || typeof receipt.turnId !== 'string' || !receipt.turnId) return { accepted: false };
  const previous = c.view.roomViews, next = { ...view, roomImages: [], roomImageVersion: randomUUID() }; delete next.roomImageSend;
  let caption;
  const proof = spaceImageCaptionProof(view);
  if (sent.captionProof && proof && sent.captionProof.revision === proof.revision && sent.captionProof.digest === proof.digest) {
    caption = { raw: view.sharedDraft, revision: view.draftRevision, recipientId: view.roomRecipient, mention: view.roomMention ? { ...view.roomMention } : null };
    next.sharedDraft = ''; next.roomMention = null; next.roomRecipient = ''; next.draftRevision++;
  }
  c.view.roomViews = { ...previous, [roomId]: next };
  try { saveViews(); } catch (error) { c.view.roomViews = previous; throw error; }
  return { accepted: true, refs: [], version: next.roomImageVersion, ...(caption ? { caption } : {}) };
}
async function cleanupSpaceImageCopies(c, roomId) {
  const images = require('./space-images.cjs');
  try { if (!images.hasSpaceImageCopies(dataDir, roomId)) return { removed: 0, failed: false }; }
  catch { return { failed: true }; }
  const client = c.client, entries = client.entries;
  const connections = Array.isArray(entries) ? entries.map(e => e.client) : [];
  const available = () => {
    if (c.client !== client || client.closing || client.socket?.destroyed || client.entries !== entries || !Array.isArray(entries) || !entries.length ||
        entries.some((e, i) => e.closed || e.closing || e.client !== connections[i] || client.control?.maintenance?.has(e.key))) return false;
    try {
      const keys = require('./service-layout.cjs').readLayout(dataDir).entries;
      return JSON.stringify(keys.toSorted()) === JSON.stringify(entries.map(e => e.key).sort());
    } catch { return false; }
  };
  if (!available()) return { failed: true };
  try {
    // A successful send can clear another window's draft while initial is in
    // flight. Keep that pre-read owner too, and never delete newly created files.
    const candidates = images.spaceImageCopyIds(dataDir, roomId);
    const before = views.map(view => ({ roomViews: { [roomId]: {
      roomImages: (view.roomViews?.[roomId]?.roomImages || []).map(ref => ({ ...ref })),
    } } }));
    const snapshot = await client.call('initial');
    if (!available() || snapshot.storageWarning || viewStorageWarning) return { failed: true };
    const keep = images.spaceImageKeepIds([...before, ...views], snapshot, roomId);
    return images.removeUnusedSpaceImages(dataDir, roomId, keep, candidates);
  } catch { return { failed: true }; }
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
    // Moving idle sessions too (T-122): automatic only where the runtime proves nothing would be lost.
    const plan = old && !unavailable && entry !== client.active ? backendSwitch.backendPlan(entry.state, value => client.sessionState?.(value) || value.state, runningRelays(client)) : null;
    options.push({ backendKey: entry.key, id: record.id, nativeId: record.nativeId || null, version: version || null,
      switch: plan && (plan.stops.length || plan.blocked) ? { ready: plan.ready, auto: plan.auto, reason: plan.reason, reasonUiMessage: plan.reasonUiMessage || null, stops: plan.stops, endsCodex: Boolean(plan.endsCodex) } : null,
      count: visible.length, ready: Boolean(old && status.ready && !unavailable && !effectiveActive),
      // Which sessions this backend holds, so a menu can name them (T-131).
      sessions: visible.map(value => ({ id: value.id, name: typeof value.name === 'string' ? value.name.slice(0, 80) : '' })),
      reason: unavailable ? '这个后台连接正在更新或已断开，原会话继续保留。' : !old ? '版本未知、较新或无法比较，不能把它当作旧后台自动更新。原连接保留。'
        : effectiveActive ? status.reason || '原生会话尚未确认结束；原连接保留，不会自动安排重启。' : status.reason || '',
      reasonUiMessage: unavailable ? uiError('error.connection.updating').uiMessage : !old ? uiError('error.connection.versionNotOlder').uiMessage
        : effectiveActive && !status.reason ? uiError('error.connection.nativeEndUnconfirmed').uiMessage : status.reasonUiMessage || null });
  }
  return options;
}
// Sessions in a running relay in any backend, including cross-backend relays.
function runningRelays(client) {
  const ids = new Set();
  for (const entry of client.entries) for (const room of [entry.state.room, ...(Array.isArray(entry.state.rooms) ? entry.state.rooms : [])]) if (room?.run?.status === 'running') for (const id of room.run.ids || []) ids.add(id);
  return ids;
}
function showDialog(c, kind, options) {
  const method = { message: 'showMessageBox', open: 'showOpenDialog', save: 'showSaveDialog' }[kind];
  return background.dialog(c, kind, options, (win, value) => dialog[method](win, value));
}
function register(name, handler) {
  applicationHandlers.set(name, async (c, ...args) => {
    if (c.background) {
      const request = backgroundOperation.request();
      if (!request || request.context !== c) throw Error('Background command has no originating operation');
      await request.valid();
      if (backgroundOperation.deliveryTargets(name, args)) {
        await c.client.refresh();
        backgroundOperation.assertDeliveryPolicy(c.client.snapshot(), name, args);
      }
      if (['approve', 'operatorAction', 'wakePolicy', 'backendSwitchSettings', 'quitService'].includes(name)) {
        const answer = await showDialog(c, 'message', { type: 'warning', message: name, detail: JSON.stringify(args), buttons: [displayText('common.cancel'), displayText('background.confirm')], cancelId: 0 });
        if (answer.response !== 1) return { cancelled: true };
      }
      if (name === 'input') {
        const s = (await c.client.call('initial')).sessions.find(s => s.id === args[0]);
        if (s?.approval || s?.nativeApproval || s?.nativeInputRequired) {
          const answer = await showDialog(c, 'message', { type: 'warning', message: name, detail: JSON.stringify(args), buttons: [displayText('common.cancel'), displayText('background.confirm')], cancelId: 0 });
          if (answer.response !== 1) return { cancelled: true };
        }
      }
      // Never silently fall back to an old backend that cannot retain actor
      // attribution or preserve the person's draft for these input paths.
      const local = new Set(['interfaceSettings', 'initial', 'uiReady', 'viewState', 'readingState', 'draft', 'retainDraftRecovery', 'discardDraftRecovery', 'rename', 'sidebar', 'roomRename', 'roomNotes', 'roomMemberOrder', 'spaceCreate', 'spaceFiles', 'openLocalFile', 'closeLocalFile', 'saveLocalFile', 'chooseFolder', 'copy', 'pasteText', 'copyImage', 'previewImage', 'expandImage', 'releaseImage', 'newWindow', 'openExternal', 'openMessageFile', 'dataDirectory', 'preflight', 'runtimeLocation', 'connectionUpdates', 'retrySave', 'archiveSession', 'restoreSession', 'archiveRoom', 'restoreRoom']);
      if (!local.has(name)) {
        const targetIds = (name === 'spaceAction' ? [args[2]?.[0]].flat() : [args[0]].flat()).filter(id => typeof id === 'string');
        const targets = c.client.entries.filter(e => !targetIds.length || e.state.sessions.some(s => targetIds.includes(s.id)));
        for (const entry of targets.length ? targets : c.client.entries) if (!entry.state.capabilities?.includes(backgroundOperation.CAPABILITY)) throw Error('This backend must adopt background-control support before this operation');
      }
    }
    return handler(c, ...args);
  });
  ipcMain.handle(`workspace:${name}`, async (event, ...args) => {
    const context = windows.get(event.sender.id);
    if (!context || event.senderFrame !== event.sender.mainFrame || !trusted(event.senderFrame.url)) throw new Error('Unexpected IPC source');
    try { return { ok: true, value: await handler(context, ...args) }; }
    catch (error) { return { ok: false, error: error.message || '操作未完成。', uiMessage: error.message ? uiLocale.displayMessage(error.uiMessage) : uiError('error.main.operationIncomplete').uiMessage }; }
  });
}
async function replaceBackendSockets(key) {
  // Replace only the updated backend's sockets. Other live transports and every
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
}
let backendSwitching = null, switchRecords = {};
const autoSwitchFailed = new Set();
// Sessions a move ended (or left disconnected or in error) that are still not live with the same native
// identity; reconnected or archived ones drop out.
const notReconnected = (sessions, value) => sessions.some(s => s.id === value.id && s.nativeId === value.nativeId && !s.archived && !['idle', 'working', 'approval', 'starting'].includes(s.state));
function endedByMove(sessions) {
  return Object.entries(switchRecords).filter(([key]) => key !== backendSwitching).flatMap(([, record]) => record.sessions
    .filter(value => notReconnected(sessions, value)).map(value => ({ id: value.id, name: value.name })));
}
async function runBackendSwitch(c, option, requireAuto = false) {
  if (backendSwitching) throw uiError("error.backendUpdateBusy");
  backendSwitching = option.backendKey;
  let finishMaintenance;
  try {
    finishMaintenance = c.client.maintainService(option.backendKey);
    const result = await backendSwitch.switchBackend({ dataDir, key: option.backendKey, executablePath: process.execPath, expected: option.switch, requireAuto,
      ensure: ensureService, owner: c.view.owner, sessionState: value => c.client.sessionState?.(value) || value.state, running: () => runningRelays(c.client) });
    // The move itself is done; a window that cannot reconnect is a separate problem.
    try { await replaceBackendSockets(option.backendKey); } catch { result.reconnectFailed = true; }
    return result;
  } finally { finishMaintenance?.(); backendSwitching = null; switchRecords = backendSwitch.readRecords(dataDir); broadcastRoom().catch(() => {}); }
}
// Automatic moves run only for plans the runtime proved, one backend at a time.
async function autoBackendSwitch() {
  if (quitting || backendSwitching || !backendSwitch.readSettings(dataDir).auto) return;
  const c = [...windows.values()].find(context => !context.background && !context.win.isDestroyed() && !context.client.closing && !context.client.socket.destroyed);
  if (!c) return;
  await c.client.refresh();
  const option = connectionUpdateOptions(c.client, app.getVersion(), roomState).find(value => value.switch?.ready && value.switch.auto && !autoSwitchFailed.has(value.backendKey));
  if (!option) return;
  let notice;
  try { const result = await runBackendSwitch(c, option, true); notice = { resumed: result.resumed.length, left: result.left.length, reconnectFailed: result.reconnectFailed }; }
  // A failed automatic move is not retried in this app run; the person can still click.
  catch (error) { autoSwitchFailed.add(option.backendKey); notice = { error: error.message || '后台更新未完成。', errorUiMessage: error.message ? uiLocale.displayMessage(error.uiMessage) : uiError('error.backendAutoUpdateIncomplete').uiMessage }; }
  for (const context of windows.values()) if (!context.win.isDestroyed()) context.win.webContents.send('workspace:backend-switched', notice);
}
let backendSwitchTimer;
async function boot() {
  dataDir = app.getPath('userData'); fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 }); fs.chmodSync(dataDir, 0o700);
  if (!outboxBroker) {
    const descriptorFile = path.join(dataDir, 'outbox-owner.json');
    delete process.env.NAW_OUTBOX_DESCRIPTOR;
    try {
      outboxBroker = await createOutboxBroker({ descriptorFile,
        bind: (identity, args, signal) => bindOriginalOutbox({ contexts: () => windows.values(), roomState }, identity, args, signal),
        bindControl: (identity, args, signal) => bindOriginalControl({ contexts: () => windows.values(), roomState }, identity, args, signal),
        control: (binding, args) => { if (!backgroundControl) throw Error('Background control storage is unavailable'); return backgroundControl.call(binding, args); },
        createView: createStockOutboxView });
      process.env.NAW_OUTBOX_DESCRIPTOR = descriptorFile; outboxUnavailable = false;
    } catch { outboxUnavailable = true; } // Existing warning surface; never block ordinary app startup.
  }
  sessionLabels = new SessionLabels(dataDir);
  roomState = new RoomState(dataDir);
  viewStore = new ViewStore(dataDir);
  const loaded = dropRetiredViewFields(viewStore.load());
  views = loaded.views;
  try { backgroundControl ||= new background.BackgroundControl({ dataDir, handlers: applicationHandlers, changed: () => { broadcastRoom().catch(() => {}); },
    context: async (actor, saved) => {
      const view = saved || { owner: randomUUID(), selected: actor.id, mode: 'chat', preference: 'chat', active: false };
      backups(view);
      const client = await connect(dataDir, view.owner);
      const win = new BrowserWindow({ ...windowOptions(), show: false, focusable: false, skipTaskbar: true });
      const context = { background: true, actor, win, client, view, failed: false };
      context.checkActor = async () => {
        await client.refresh();
        const record = client.snapshot().sessions.find(s => s.id === actor.id);
        if (!record || record.nativeId !== actor.nativeId || record.archived || record.nativeContextPending) throw Error('The originating native session changed');
      };
      context.fingerprint = command => {
        const strings = new Set();
        const scan = v => { if (typeof v === 'string') strings.add(v); else if (Array.isArray(v)) v.forEach(scan); else if (v && typeof v === 'object') Object.values(v).forEach(scan); };
        scan(command.arguments);
        const state = client.snapshot();
        const global = ['quitService', 'clearSharedHistory', 'archiveRoom', 'switchBackend', 'continueConnection'].includes(command.method);
        return { sessions: state.sessions.filter(s => global || strings.has(s.id)).map(s => ({ id: s.id, nativeId: s.nativeId, pid: s.pid, owner: s.owner, state: s.state, activeTurnId: s.activeTurnId, pendingTag: s.pendingTag, controlRevision: s.controlRevision,
          connectionRevision: s.connectionRevision, archived: s.archived, approval: s.approval, nativeApproval: s.nativeApproval })),
          rooms: (state.rooms || [state.room]).filter(r => r && (global || strings.has(r.id))).map(r => ({ id: r.id, memberIds: r.memberIds })) };
      };
      context.delivery = async (command, value, sender, guard) => {
        const method = command.method === 'spaceAction' ? command.arguments[1] : command.method;
        if (!['send', 'forward', 'queue', 'queueShared', 'steer', 'steerShared'].includes(method)) return null;
        const args = command.method === 'spaceAction' ? command.arguments[2] : command.arguments;
        await client.refresh();
        const record = client.snapshot().sessions.find(s => s.id === args[0]);
        const expected = guard?.sessions?.find(s => s.id === args[0]);
        if (!record || expected && record.nativeId !== expected.nativeId || record.nativeContextPending) return { recipientId: args[0], nativeReceived: false, status: 'context-changed' };
        const message = record.messages.find(m => m.agentControl?.operationId === sender.operationId && m.agentControl?.id === sender.id && m.agentControl?.nativeId === sender.nativeId);
        if (!message) return { recipientId: args[0], nativeReceived: false, status: 'unconfirmed' };
        return { recipientId: record.id, nativeId: record.nativeId, messageId: message.id,
          nativeReceived: message.status === 'submitted', status: message.status, body: message.text };
      };
      const id = win.webContents.id;
      windows.set(id, context); bindClient(context);
      win.on('closed', () => { windows.delete(id); client.close(); });
      return context;
    } }); backgroundUnavailable = false;
  } catch { backgroundUnavailable = true; }
  if (loaded.changed) saveViews();
  process.env.NAW_RUNTIME_CONFIG = path.join(dataDir, 'runtime-locations.json');
  await ensureService(dataDir, process.execPath);
  await startQueueDispatcher();
  switchRecords = backendSwitch.readRecords(dataDir);
  if (quitting) return;
  const generation = localeHostGeneration;
  dsh = await startDsh(dataDir, { onLocale: value => acceptLocale(value, generation) }); entry = dsh.url;
  if (quitting) { dsh.stop(); return; }
  // The fresh launch URL authenticates all restored windows after this cleanup.
  await resetUiAuthentication(session.defaultSession);
  for (const view of views) { try { view.readingPositions = readingState(view.readingPositions || {}); } catch { view.readingPositions = {}; } }
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => callback({ cancel: new URL(details.url).host !== new URL(dsh.origin).host }));
  if (!wired) {
  wired = true;
  register('backgroundDecision', (c, sessionId, nativeId, id, response) => {
    if (c.background) throw Error('An agent cannot confirm its own background request');
    return backgroundControl.decide(sessionId, nativeId, id, response);
  });
  for (const name of ['prepareInput', 'observe', 'unobserve', 'claim', 'terminal', 'terminalSnapshot', 'input', 'resize', 'interrupt', 'pause', 'approve', 'answer', 'wakePolicy', 'operatorAction']) register(name, (c, ...args) => {
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
    const state = await c.client.call('initial'); if (!state.sessions.some(s => s.id === id)) throw uiError("error.main.nativeRecordsUnavailable");
    roomState.restoreSession(id); await broadcastRoom();
  });
  register('archiveRoom', async c => { try { await roomState.archiveRoom(c.client, sessionLabels.labels); } finally { await broadcastRoom(); } });
  register('restoreRoom', async c => { try { await roomState.restoreRoom(c.client, sessionLabels.labels); } finally { await broadcastRoom(); } });
  register('spaceCreate', async (_c, name) => { const id = roomState.create(name); await broadcastRoom(); return id; });
  register('spaceMerge', async (c, action, value) => {
    if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw uiError("error.main.invalidMergeRequest");
    if (action === 'preview') return roomState.mergePreview(c.client, value);
    if (!validRoomId(value.operationId) || value.operationId === 'shared' || Object.keys(value).some(key => !['operationId', 'binding'].includes(key))) throw uiError("error.main.mergeRecordUnverifiable");
    if (action === 'discard') { roomState.discardMergePreview(value.operationId); return; }
    if (action === 'status') return roomState.mergeStatus(c.client, value.operationId);
    if (!['commit', 'recover', 'undo'].includes(action) || !/^[a-f0-9]{64}$/u.test(value.binding)) throw uiError("error.main.invalidMergeConfirmation");
    try {
      const targetId = roomState.mergeRecord(value.operationId)?.id;
      const keepDraft = hasSavedSpaceDraft(views, targetId);
      return action === 'undo' ? await roomState.mergeUndo(c.client, value.operationId, value.binding, keepDraft)
        : await roomState.mergeCommit(c.client, value.operationId, value.binding, action === 'recover');
    } finally { await broadcastRoom(); }
  });
  register('spaceAction', async (c, roomId, action, args = []) => {
    if (!validRoomId(roomId) || !Array.isArray(args) || args.length > 8) throw uiError("error.invalidSpaceAction");
    roomState.metadata(roomId); // Never reinterpret a missing space as shared.
    if (action === 'join') {
      try { return await roomState.membership(c.client, args[0], args[1], sessionLabels.labels.get(args[0]), roomId, args[2]); }
      finally { await broadcastRoom(); }
    }
    if (['stageImages', 'removeImage'].includes(action)) {
      if (action === 'stageImages') await cleanupSpaceImageCopies(c, roomId);
      const result = updateSpaceImageDraft(c, roomId, action, args[0], args[1]);
      if (action === 'removeImage') result.imagesLeft = (await cleanupSpaceImageCopies(c, roomId)).failed;
      return result;
    }
    if (action === 'acceptImages') return acceptSpaceImageDraft(c, roomId, args[0], args[1]);
    if (action === 'rename') roomState.rename(args[0], roomId);
    else if (action === 'notes') roomState.notes(args[0], args[1], roomId);
    else if (action === 'memberOrder') roomState.moveMember(args[0], (await c.client.call('initial')).sessions, roomId);
    else if (action === 'archive' || action === 'restore') {
      try { return await roomState[action === 'archive' ? 'archiveRoom' : 'restoreRoom'](c.client, sessionLabels.labels, roomId); }
      finally { await broadcastRoom(); }
    } else if (action === 'removeFile') roomState.removeFile(args[0], args[1], roomId);
    else if (['queueAdd', 'queueCancel', 'queueResolve'].includes(action) && c.background) {
      // Only the person changes a queue until they decide agents may (2026-11-08 review).
      throw uiError("error.queue.personOnly");
    } else if (action === 'queueAdd') {
      const itemId = roomState.queueAdd(args[0], args[1] ?? null, roomId);
      await broadcastRoom();
      queueDispatcher?.schedule();
      return itemId;
    } else if (action === 'queueCancel') roomState.queueCancel(args[0], roomId);
    else if (action === 'queueResolve') {
      roomState.queueResolve(args[0], roomId);
      queueDispatcher?.schedule();
    }
    else if (['forward', 'queueShared', 'steerShared', 'run', 'pause', 'clearSharedHistory'].includes(action)) {
      if (action === 'clearSharedHistory') {
        roomState.writable(roomId);
        // A clear every backend would refuse is refused before the person is asked; the client checks again after (T-149).
        const refusal = await c.client.clearSharedHistoryProblem(roomId); if (refusal) throw typeof refusal === 'string' ? Error(refusal) : refusal;
        const value = roomState.metadata(roomId), revision = value.revision;
        const answer = await showDialog(c, 'message', { type: 'warning', message: displayText('os.clearSpaceTitle', { name: value.name }), detail: displayText('os.clearSpaceDetail'), buttons: [displayText('common.cancel'), displayText('os.clearSharedButton')], defaultId: 0, cancelId: 0 });
        if (answer.response !== 1) return false;
        if (roomState.metadata(roomId).revision !== revision) throw uiError("error.main.spaceDataChangedBeforeClear");
        roomState.writable(roomId);
        const result = await c.client.callSpace(roomId, action, []);
        try { roomState.clear(revision, roomId); } catch (error) { throw uiError("error.sharedClearedRetained", { reason: error.message }, { cause: error, param: 'reason' }); }
        const copies = await cleanupSpaceImageCopies(c, roomId);
        await broadcastRoom();
        if (result?.imagesLeft || copies.failed) throw uiError("error.sharedRemovedImagesRetained");
        return true;
      }
      if (action !== 'pause') for (const id of action === 'run' && Array.isArray(args[0]) ? args[0] : [args[0]]) roomState.assertAvailable(id, true, roomId);
      if (action === 'run' && Array.isArray(args[0])) {
        const snapshot = sessionLabels.apply(c.client.snapshot(roomId));
        if (args[4] && args[0].some(id => args[4][id] !== snapshot.sessions.find(s => s.id === id)?.name)) throw uiError("error.main.participantNamesChanged");
        args[4] = Object.fromEntries(args[0].filter(id => sessionLabels.labels.has(id)).map(id => [id, sessionLabels.labels.get(id)]));
      }
      if (action === 'forward' && args[4]) return forwardSpaceImages(c, roomId, args);
      return c.client.callSpace(roomId, action, args);
    } else throw uiError("error.main.unsupportedSpaceAction");
    await broadcastRoom();
  });
  register('spaceFiles', async (c, roomId, fileId) => {
    if (!validRoomId(roomId)) throw uiError("error.main.invalidSpace");
    const value = roomState.metadata(roomId);
    if (fileId !== undefined) {
      const file = value.files.find(f => f.id === fileId); if (!file) throw uiError("error.main.fileReferenceChanged");
      const preview = await readPreview(file.path);
      if (c.win.isDestroyed() || !roomState.metadata(roomId).files.some(f => f.id === fileId && f.path === file.path)) throw uiError("error.main.spaceFileListChanged");
      c.filePreview = preview;
      return { token: preview.token, name: preview.name, text: preview.text, size: preview.bytes.length };
    }
    roomState.assertAvailable(null, true, roomId);
    if (c.fileChoosing) throw uiError("error.main.filePickerAlreadyOpen");
    c.fileChoosing = true;
    try {
      const result = await showDialog(c, 'open', { title: displayText('os.spaceFileTitle', { name: value.name }), filters: [{ name: displayText('os.textFiles'), extensions: textExtensions }], properties: ['openFile', 'multiSelections', 'dontAddToRecent'] });
      if (result.canceled || c.win.isDestroyed()) return false;
      for (const file of result.filePaths) await readPreview(file);
      roomState.assertAvailable(null, true, roomId); roomState.addFiles(result.filePaths, roomId); await broadcastRoom(); return true;
    } finally { c.fileChoosing = false; }
  });
  register('gitWorktreePreview', async (c, selected, nonce, relative) => {
    if (selected !== c.worktreeSource) throw uiError("error.main.selectRepositoryFirst");
    const revision = c.worktreePreviewRevision = (c.worktreePreviewRevision || 0) + 1;
    c.worktreePlan = null;
    const plan = await c.client.call('gitWorktreePreview', selected, nonce, relative);
    if (c.win.isDestroyed() || c.worktreeSource !== selected || c.worktreePreviewRevision !== revision) throw uiError("error.main.repositoryPreviewChanged");
    c.worktreePlan = plan; return plan;
  });
  register('create', async (c, ...args) => {
    assertNativeCreation(await c.client.call('initial'));
    if (args[0]?.gitWorktree != null) {
      const requested = args[0].gitWorktree, plan = c.worktreePlan;
      if (!plan || Object.keys(requested).length !== Object.keys(plan).length || Object.keys(plan).some(key => requested[key] !== plan[key])) throw uiError("error.main.worktreePreviewExpired");
      c.worktreePlan = null;
    }
    return c.client.call('create', ...args);
  });
  register('nativeHistory', (c, options) => c.client.call('nativeHistory', options));
  register('importHistory', (c, nativeId, options) => c.client.call('importHistory', nativeId, options));
  register('rename', async (c, id, name) => {
    const snapshot = await c.client.call('initial');
    if (!snapshot.sessions.some(s => s.id === id)) throw uiError("error.main.renameSessionMissing");
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
    // Uploaded images must resolve from this window's saved space draft.
    // The legacy text-only entry must never accept a caller's image packet.
    if (method === 'forward' && args.length > 4) throw uiError('error.roomImages.changed');
    if (method === 'run' && Array.isArray(args[0])) {
      if (args[4]) {
        const snapshot = sessionLabels.apply(c.client.snapshot());
        if (args[0].some(id => args[4][id] !== snapshot.sessions.find(s => s.id === id)?.name)) throw uiError("error.main.participantNamesChanged");
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
  register('interfaceSettings', (_c, ...args) => dsh.settings(...args));
  register('runtimeLocation', async (c, key, reset = false) => {
    if (!['claude', 'codex', 'python3'].includes(key) || typeof reset !== 'boolean') throw uiError("error.main.unknownProgramSetting");
    if (reset) setLocation(process.env.NAW_RUNTIME_CONFIG, key, null);
    else {
      const result = await showDialog(c, 'open', { title: displayText('os.chooseProgram'), buttonLabel: displayText('os.useProgram'), properties: ['openFile', 'showHiddenFiles'] });
      if (!result.canceled && result.filePaths.length === 1) setLocation(process.env.NAW_RUNTIME_CONFIG, key, result.filePaths[0]);
    }
    return preflight();
  });
  register('dataDirectory', c => c.background ? { path: dataDir } : shell.openPath(dataDir));
  register('quitService', async c => { await c.client.call('shutdown'); app.quit(); });
  register('clearSharedHistory', async c => {
    const state = await c.client.call('initial');
    if (state.room.run?.pausePending || state.room.run?.pauseUnconfirmed) throw uiError("error.main.clearNeedsLeaseRevocation");
    const answer = await showDialog(c, 'message', { type: 'warning', message: displayText('os.clearSharedTitle'), detail: displayText('os.clearSharedDetail'), buttons: [displayText('common.cancel'), displayText('os.clearSharedButton')], defaultId: 0, cancelId: 0 });
    if (answer.response === 1) {
      const revision = roomState.value.revision;
      const result = await c.client.call('clearSharedHistory');
      try { roomState.clear(revision); } catch (error) { throw uiError("error.sharedClearedRetained", { reason: error.message }, { cause: error, param: 'reason' }); }
      const copies = await cleanupSpaceImageCopies(c, 'shared');
      if (result?.imagesLeft || copies.failed) { await broadcastRoom(); throw uiError("error.sharedRemovedImagesRetained"); }
      await broadcastRoom(); return true;
    }
  });
  register('draft', async (c, id, text) => {
    if (typeof text !== 'string' || text.length > 16000) throw uiError("error.main.draftTooLong");
    if (typeof id !== 'string' || id.length > 100) throw uiError("error.main.invalidSession");
    const draft = beginDraft(c.view, id, text); saveViews();
    if (c.background) { acknowledgeDraft(c.view, id, draft); return; }
    try { roomState.assertAvailable(id); await c.client.call('draft', id, text); }
    catch (error) {
      if (backups(c.view)[id] === draft && text) { retainRecovery(c.view, id, text); saveViews(); }
      throw error;
    }
    if (acknowledgeDraft(c.view, id, draft)) saveViews();
  });
  for (const [name, operation] of [['retainDraftRecovery', retainRecovery], ['discardDraftRecovery', discardRecovery]]) register(name, (c, id, text) => {
    if (typeof id !== 'string' || id.length > 100 || typeof text !== 'string' || text.length > 16000) throw uiError("error.main.invalidDraftCopy");
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
  register('backendSwitchSettings', async (c, auto) => {
    const settings = typeof auto === 'boolean' ? backendSwitch.writeSettings(dataDir, auto) : backendSwitch.readSettings(dataDir);
    // A record not belonging to a move in progress names sessions a move ended, including after a quit
    // mid-move; a record whose sessions all run again is cleared.
    await c.client.refresh(); const snapshot = c.client.snapshot(), live = snapshot.sessions;
    for (const [key, record] of Object.entries(backendSwitch.readRecords(dataDir))) if (key !== backendSwitching && !record.sessions.some(value => notReconnected(live, value))) backendSwitch.clearRecord(dataDir, key);
    switchRecords = backendSwitch.readRecords(dataDir);
    return { auto: settings.auto, interrupted: endedByMove(roomState.apply(snapshot).sessions).map(value => value.name) };
  });
  register('switchBackend', async (c, expected) => {
    await c.client.refresh();
    const option = connectionUpdateOptions(c.client, app.getVersion(), roomState).find(value => value.backendKey === expected?.backendKey);
    const same = value => backendSwitch.samePlan(value, expected?.switch);
    if (!option?.switch?.ready || !same(option.switch)) throw uiError("error.backendSwitchRecheck");
    const names = option.switch.stops.map(value => value.name).join('、');
    const answer = await showDialog(c, 'message', {
      type: 'warning', message: displayText('os.switchBackendTitle', { count: option.switch.stops.length }),
      detail: displayText('os.switchBackendDetail', { names }) +
        (option.switch.endsCodex ? '\n\n' + displayText('os.switchBackendCodex') : '') +
        (option.switch.reason ? '\n\n' + displayText('os.switchBackendUnconfirmed', { reason: uiLocale.displayText(displayLanguage(), option.switch.reason, option.switch.reasonUiMessage) }) : ''),
      buttons: [displayText('os.keepConnection'), displayText('os.confirmSwitchBackend')], defaultId: 0, cancelId: 0,
    });
    if (answer.response !== 1) return false;
    return runBackendSwitch(c, option);
  });
  register('continueConnection', async (c, id, expected) => {
    await c.client.refresh();
    const target = c.client.route(id), status = continuationStatus(target.state, id);
    const guard = c.client.operationGuard(target), nativeId = target.state.sessions.find(record => record.id === id)?.nativeId, version = target.state.runtimeVersion;
    const matches = value => value && value.backendKey === target.key && value.nativeId === nativeId && value.version === version;
    if (expected !== undefined && (!matches(expected) || !connectionUpdateOptions(c.client, app.getVersion(), roomState).some(option => option.id === id && option.ready && matches(option)))) throw uiError("error.main.backendUpdateEligibilityChanged");
    if (!status.ready) {
      await showDialog(c, 'message', { type: 'info', message: displayText('os.keepNativeWork'), detail: uiLocale.displayText(displayLanguage(), status.reason, status.reasonUiMessage), buttons: [displayText('os.ok')] });
      return false;
    }
    const answer = await showDialog(c, 'message', {
      type: 'warning', message: displayText('os.updateConnectionTitle'),
      detail: displayText('os.updateConnectionDetail'),
      buttons: [displayText('os.keepConnection'), displayText('os.confirmUpdate')], defaultId: 0, cancelId: 0,
    });
    if (answer.response !== 1) return false;
    guard(); await c.client.refresh(); guard();
    const current = c.client.route(id), record = current.state.sessions.find(value => value.id === id), fresh = continuationStatus(current.state, id);
    if (current !== target || current.state.runtimeVersion !== version || record?.nativeId !== nativeId || !fresh.ready ||
        expected !== undefined && !connectionUpdateOptions(c.client, app.getVersion(), roomState).some(option => option.id === id && option.ready && matches(option))) throw uiError("error.main.backendChangedDuringCheck");
    const finishMaintenance = c.client.maintainService(target.key);
    try {
    const { key } = await continueService(dataDir, process.execPath, id);
    await replaceBackendSockets(key);
    return true;
    } finally { finishMaintenance(); }
  });
  for (const action of ['resume', 'forget']) register(action, async (c, id) => {
    const snapshot = await c.client.call('initial');
    const record = snapshot.sessions.find(s => s.id === id);
    const resubscribe = action === 'resume' && (record?.state === 'disconnected' || record?.transportDisconnected);
    if (action === 'resume') assertNativeCreation(snapshot, id);
    if (resubscribe && !capabilitiesFor(snapshot, id).includes('resubscribe')) throw uiError("error.main.backendReconnectUnsupported");
    if (record?.transportDisconnected && !capabilitiesFor(snapshot, id).includes('transportReconnect')) throw uiError("error.main.backendGuiRestoreUnsupported");
    if (!capabilitiesFor(snapshot, id).includes(action)) throw uiError("error.main.backendActionUnsupported");
    // The explicit resume action already expresses consent. The workspace
    // still verifies identity, ownership and liveness before native resume.
    if (action === 'resume') return c.client.call(action, id);
    const answer = await showDialog(c, 'message', {
      type: 'question', message: displayText('os.forgetTitle'),
      detail: displayText('os.forgetDetail'),
      buttons: [displayText('common.cancel'), displayText('os.removeRecord')], defaultId: 0, cancelId: 0,
    });
    if (answer.response === 1) {
      const result = await c.client.call(action, id);
      if (action === 'forget') {
        for (const view of views) { delete view.readingPositions?.[id]; forgetDraft(view, id); if (view.selected === id) view.selected = ''; }
        saveViews();
        const imageRooms = new Set((record?.messages || []).flatMap(m => (m.spaceUploads || []).map(ref => ref.roomId)));
        let imagesLeft = Boolean(result?.imagesLeft);
        for (const roomId of imageRooms) if ((await cleanupSpaceImageCopies(c, roomId)).failed) imagesLeft = true;
        let labelsLeft = false; try { sessionLabels.remove(id); } catch { labelsLeft = true; }
        if (labelsLeft && imagesLeft) throw uiError("error.removedNameAndImagesRetained");
        if (labelsLeft) throw uiError("error.main.forgottenLabelCleanupFailed");
        if (imagesLeft) throw uiError("error.removedImagesRetained");
      }
    }
  });
  register('stop', async (c, id) => {
    const record = (await c.client.call('initial')).sessions.find(s => s.id === id);
    if (!record) throw uiError("error.sessionMissing");
    const codex = record.provider === 'codex';
    const answer = await showDialog(c, 'message', {
      type: 'warning', message: codex ? displayText('os.disconnectCodexTitle') : displayText('os.endNativeTitle'),
      detail: codex ? displayText('os.disconnectCodexDetail') : displayText('os.endNativeDetail'),
      buttons: [displayText('os.keepSession'), codex ? displayText('os.disconnect') : displayText('os.endSession')], defaultId: 0, cancelId: 0,
    });
    if (answer.response === 1) return c.client.call('stop', id);
  });
  register('openExternal', (c, href) => { const url = new URL(href); if (!['http:', 'https:'].includes(url.protocol)) throw uiError("error.main.unsupportedLinkType"); return c.background ? { url: url.href } : shell.openExternal(url.href); });
  register('openMessageFile', (c, source, file, options) => openMessageFile({
    snapshot: async () => roomState.apply(await c.client.call('initial')),
    openPath: target => shell.openPath(target),
    background: c.background,
    isCurrent: () => !c.win.isDestroyed() && windows.get(c.win.webContents.id) === c,
  }, source, file, options));
  register('initial', async c => {
    const appBuild = await (applicationBuild ||= appBuildInfo(app, dataDir));
    const display = displayState(await c.client.call('initial'), c);
    if (!c.background) notifyCapacity(display, c.win);
    return { ...display, viewState: c.view, appVersion: app.getVersion(), appBuild, localeWarning, preflight: preflight() };
  });
  register('readingState', (c, positions, panorama) => {
    const checked = readingState(positions);
    if (panorama !== undefined && !validViews([{ owner: c.view.owner, panorama }])) throw uiError("error.panoramaReadingInvalid");
    const presentation = panorama === undefined ? undefined : structuredClone(panorama);
    c.view.readingPositions = checked;
    if (presentation !== undefined) c.view.panorama = presentation;
    return saveReadingSoon();
  });
  register('viewState', (c, next) => {
    if (!next || typeof next.selected !== 'string' || next.selected.length > 100 || !['chat', 'terminal'].includes(next.mode)) throw uiError("error.main.invalidViewState");
    if (next.terminalLayout !== undefined && !['hidden', 'split', 'maximized'].includes(next.terminalLayout)) throw uiError("error.main.invalidTerminalLayout");
    if (next.terminalSplit !== undefined && !(Number.isFinite(next.terminalSplit) && next.terminalSplit >= 0.2 && next.terminalSplit <= 0.8)) throw uiError("error.main.invalidColumnWidth");
    if (next.roomSession !== undefined && (typeof next.roomSession !== 'string' || next.roomSession.length > 100)) throw uiError("error.main.invalidCollaborationView");
    if (next.roomRecipient !== undefined && (typeof next.roomRecipient !== 'string' || next.roomRecipient.length > 100)) throw uiError("error.main.invalidCollaborationRecipient");
    if (next.roomFilter !== undefined && (typeof next.roomFilter !== 'string' || next.roomFilter.length > 100)) throw uiError("error.main.invalidMemberFilter");
    for (const key of ['roomThread', 'roomReplyTo']) if (next[key] !== undefined) require('./room-threads.js').replyReference(next[key]);
    if (next.roomSearch !== undefined && (typeof next.roomSearch !== 'string' || next.roomSearch.length > 1000)) throw uiError("error.main.searchTooLong");
    if (next.sharedDraft !== undefined && (typeof next.sharedDraft !== 'string' || next.sharedDraft.length > 16000)) throw uiError("error.main.sharedDraftTooLong");
    if (next.roomMention !== undefined && next.roomMention !== null && !require('./room-mention.js').validView(next.roomMention, next.sharedDraft, next.roomRecipient)) throw uiError("error.main.invalidMention");
    if (next.terminalDisplay !== undefined && (!next.terminalDisplay || !Number.isInteger(next.terminalDisplay.fontSize) || next.terminalDisplay.fontSize < 10 || next.terminalDisplay.fontSize > 24 || !['dark', 'green'].includes(next.terminalDisplay.palette))) throw uiError("error.main.invalidTerminalDisplay");
    if (!validViews([{ ...c.view, ...next }])) throw uiError("error.main.invalidSpaceViewRecord");
    if (next.roomViews) {
      // Add/remove image imports have their own save-before-ACK transaction.
      // A text save sent before that ACK must not erase its newer image draft.
      for (const [id, original] of Object.entries(c.view.roomViews || {})) if (original.roomImages !== undefined) {
        next.roomViews[id] = { ...(next.roomViews[id] || original), roomImages: structuredClone(original.roomImages), roomImageVersion: original.roomImageVersion };
        // A save already in flight before image acceptance cannot resurrect
        // its consumed caption. Later human edits carry a newer generation.
        if (Number.isSafeInteger(original.draftRevision) && (next.roomViews[id].draftRevision ?? -1) < original.draftRevision) {
          for (const key of ['sharedDraft', 'roomRecipient', 'roomMention', 'draftRevision']) next.roomViews[id][key] = structuredClone(original[key]);
        }
        if (original.roomImageSend) next.roomViews[id].roomImageSend = structuredClone(original.roomImageSend);
        else delete next.roomViews[id].roomImageSend;
      }
      for (const [id, incoming] of Object.entries(next.roomViews)) if (c.view.roomViews?.[id]?.roomImages === undefined) { delete incoming.roomImages; delete incoming.roomImageVersion; delete incoming.roomImageSend; }
    }
    for (const key of ['spaceId', 'sidebarView', 'sidebarCollapsedGroups', 'columnTerminalHeights', 'roomViews', 'panorama']) if (next[key] !== undefined) c.view[key] = structuredClone(next[key]);
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
    if (c.fileChoosing) throw uiError("error.main.filePickerAlreadyOpen");
    c.fileChoosing = true;
    try {
      const snapshot = await c.client.call('initial');
      const record = snapshot.sessions.find(s => s.id === sessionId);
      if (sessionId && !record) throw uiError("error.main.sessionChangedFile");
      const result = await showDialog(c, 'open', { title: displayText('os.openMaterial'), defaultPath: record?.cwd || snapshot.defaultWorkspace,
        filters: [{ name: displayText('os.textFiles'), extensions: textExtensions }], properties: ['openFile', 'dontAddToRecent'] });
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
    if (!preview || preview.token !== token || c.fileSaving) throw uiError("error.main.filePreviewChanged");
    c.fileSaving = true;
    try {
      const ext = path.extname(preview.name);
      const result = await showDialog(c, 'save', { title: displayText('os.saveCopy'), defaultPath: `${path.basename(preview.name, ext)}-copy${ext}`, properties: ['dontAddToRecent'] });
      if (result.canceled || c.win.isDestroyed()) return false;
      if (c.filePreview !== preview) throw uiError("error.main.filePreviewChangedBeforeSave");
      await saveCopy(preview, result.filePath); return true;
    } finally { c.fileSaving = false; }
  });
  register('chooseFolder', async c => {
    const result = await showDialog(c, 'open', { title: displayText('os.chooseFolder'), properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || c.win.isDestroyed()) return null;
    c.worktreeSource = result.filePaths[0]; c.worktreePlan = null;
    c.worktreePreviewRevision = (c.worktreePreviewRevision || 0) + 1;
    return result.filePaths[0];
  });
  register('newWindow', async (c, id) => { const snapshot = await c.client.call('initial'); if (id && !snapshot.sessions.some(s => s.id === id)) throw uiError("error.main.sessionNotFound"); if (c.background) return backgroundControl.newView(c.actor, id, c.view.mode); await openWindow({ owner: randomUUID(), selected: id || '', mode: c.view.mode, preference: c.view.preference, active: true }); });
  register('copy', (c, text) => { if (typeof text !== 'string' || text.length > 100000) throw uiError("error.main.invalidCopyContent"); if (c.background) { c.clipboardText = text; c.clipboardImage = null; return; } return clipboard.writeText(text); });
  // Read only when the person presses Paste; never watch or persist clipboard content.
  register('pasteText', async c => { const text = c.background ? c.clipboardText || '' : await clipboard.readText(); if (text.length > 65500) throw uiError("error.main.pasteTooLong"); return text; });
  const imageTarget = async (c, id, expectedNativeId) => {
    roomState.assertAvailable(id);
    const snapshot = await c.client.call('initial'), record = snapshot.sessions.find(s => s.id === id);
    if (!record || !['codex', 'claude'].includes(record.provider) || record.owner !== c.view.owner || record.nativeId !== expectedNativeId || record.nativeContextPending || !record.terminalState?.alive || !['idle', 'working'].includes(record.state)) throw uiError("error.main.connectTerminalBeforeImage");
    return record;
  };
  register('stageImages', async (c, id, nativeId, files) => {
    await imageTarget(c, id, nativeId);
    return require('./local-images.cjs').saveImages(dataDir, id, files, nativeImage);
  });
  register('pasteNativeContent', async (c, id, nativeId) => {
    const image = c.background ? c.clipboardImage || nativeImage.createEmpty() : clipboard.readImage();
    if (!image.isEmpty()) {
      await imageTarget(c, id, nativeId);
      return { images: require('./local-images.cjs').saveImages(dataDir, id, [image.toPNG()], nativeImage) };
    }
    // Text keeps the original paste path, including native permission/question
    // prompts. Only importing images requires the stricter idle/working gate.
    const text = c.background ? c.clipboardText || '' : clipboard.readText(); if (text.length > 65500) throw uiError("error.main.pasteTooLong"); return { text };
  });
  const imagesFor = c => c.imagePreviews ||= new ImagePreviews({ nativeImage,
    snapshot: async source => source?.kind === 'space-draft' ? null : roomState.apply(await c.client.call('initial')),
    resolveSource: (snapshot, source) => {
      if (source?.kind === 'space-message') {
        if (!validRoomId(source.roomId) || typeof source.messageId !== 'string' || !source.messageId || source.messageId.length > 100 ||
            !Number.isSafeInteger(source.index) || source.index < 0 || source.index > 3 || Object.keys(source).some(key => !['kind', 'roomId', 'messageId', 'index'].includes(key))) throw uiError('error.roomImages.changed');
        const room = (snapshot.rooms || [snapshot.room]).find(r => (r?.id || 'shared') === source.roomId), row = room?.messages?.find(m => m.id === source.messageId);
        if (!row?.imageDraftVersion || row.role !== 'human' || !row.deliveryTracked || !row.recipientId) throw uiError('error.roomImages.changed');
        try { const ref = row.images?.[source.index], read = require('./space-images.cjs').readSpaceImage(dataDir, ref?.roomId, ref); return { path: read.path, fileIdentity: read.fileIdentity, observedAt: read.fileIdentity[3] }; }
        catch { throw uiError('error.roomImages.changed'); }
      }
      if (source?.kind !== 'space-draft') return imageSource(snapshot, source);
      const view = c.view.roomViews?.[source.roomId];
      if (!validRoomId(source.roomId) || view?.roomImageVersion !== source.messageId || !Number.isSafeInteger(source.index) || source.index < 0 || source.index > 3 ||
          Object.keys(source).some(key => !['kind', 'roomId', 'messageId', 'index'].includes(key))) throw uiError('error.roomImages.changed');
      try {
        const read = require('./space-images.cjs').readSpaceImage(dataDir, source.roomId, view.roomImages?.[source.index]);
        // This is the uploaded file's stable timestamp, never a native-read event.
        return { path: read.path, fileIdentity: read.fileIdentity, observedAt: read.fileIdentity[3] };
      } catch { throw uiError('error.roomImages.changed'); }
    } });
  register('previewImage', (c, source) => imagesFor(c).preview(source));
  register('expandImage', (c, token) => imagesFor(c).expand(token));
  register('copyImage', (c, token) => imagesFor(c).copy(token, c.background ? { writeImage: image => { c.clipboardImage = image; c.clipboardText = ''; } } : clipboard));
  register('releaseImage', (c, token) => c.imagePreviews?.release(token));
  updateApplicationMenu();
  }
  const restore = views.filter(v => v.active);
  if (restore.length) for (const view of restore) await openWindow(view);
  else await openWindow(views.at(-1));
  if (quitting) return;

}
async function start() {
  if (starting || quitting) return; starting = true;
  localeHostGeneration++;
  await readStartupLocale();
  if (!startupWindow || startupWindow.isDestroyed()) { startupWindow = createWindow(); await startupWindow.loadFile(startupFile); }
  startupWindow.webContents.send('workspace:startup', { kind: 'opening', title: displayText('startup.opening'), detail: displayText('startup.connecting'), retry: false });
  try {
    await boot();
    if (!backendSwitchTimer) { backendSwitchTimer = setInterval(() => autoBackendSwitch().catch(() => {}), (testRequested && Number(process.env.NAW_TEST_BACKEND_SWITCH_MS)) || 60000); backendSwitchTimer.unref?.(); }
  }
  catch (error) {
    dsh?.stop();
    await backgroundControl?.close(); backgroundControl = null;
    for (const c of [...windows.values()]) { c.failed = true; c.client.close(); c.win.destroy(); }
    if (!quitting && (!startupWindow || startupWindow.isDestroyed())) {
      startupWindow = createWindow(); await startupWindow.loadFile(startupFile);
    }
    if (!quitting && startupWindow && !startupWindow.isDestroyed()) startupWindow.webContents.send('workspace:startup', { kind: 'failed', code: uiLocale.startupCode(error.code), title: displayText('startup.failed'), detail: startupMessage(error, displayLanguage()), retry: true, data: error.code === 'NAW_VIEW_RECORD' });
  } finally { starting = false; if (!quitting) updateApplicationMenu(); }
}
ipcMain.handle('workspace:retry-startup', event => { if (startupWindow?.webContents === event.sender && event.senderFrame === event.sender.mainFrame && event.senderFrame.url === pathToFileURL(startupFile).href) return start(); });
ipcMain.handle('workspace:startup-data', event => { if (startupWindow?.webContents === event.sender && event.senderFrame === event.sender.mainFrame && event.senderFrame.url === pathToFileURL(startupFile).href && viewStore && !viewStore.loaded) return shell.openPath(dataDir); });
function focusOrOpen() {
  if (backgroundLaunch && !backgroundTest && process.platform === 'darwin') app.setActivationPolicy('regular');
  backgroundLaunch = false;
  const win = startupWindow && !startupWindow.isDestroyed() ? startupWindow : [...windows.values()].find(c => !c.background && !c.win.isDestroyed())?.win;
  if (win) { if (!backgroundTest) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } }
  else if (!starting && !quitting) {
    if (dsh && wired) {
      starting = true;
      openWindow(views.at(-1)).finally(() => { starting = false; }).catch(() => start());
    } else start();
  }
}
app.on('activate', focusOrOpen);
app.on('second-instance', (_event, argv) => { if (!argv?.includes('--background')) focusOrOpen(); });
if (primary) app.whenReady().then(start);
app.on('window-all-closed', () => {});
app.on('before-quit', event => {
  if (outboxClosing) { event.preventDefault(); return; }
  if (quitting) return;
  try {
    if (viewStore?.loaded) {
      for (const { win, view } of windows.values()) if (!win.isDestroyed()) view.bounds = win.getBounds();
      saveViews();
    }
  } catch { event.preventDefault(); return; }
  if (outboxQuitFailed) { quitting = true; dsh?.stop(); return; }
  if (outboxBroker) {
    event.preventDefault();
    outboxClosing = true;
    Promise.resolve().then(() => Promise.all([outboxBroker.close(), backgroundControl?.close()])).then(() => {
      outboxClosing = false; quitting = true; dsh?.stop(); setImmediate(() => app.quit());
    }, () => {
      outboxClosing = false; outboxUnavailable = true; outboxQuitFailed = true;
      for (const context of windows.values()) {
        try { if (!context.win.isDestroyed()) context.win.webContents.send('workspace:state', displayState(context.client.snapshot(), context)); } catch {}
      }
    });
  } else { quitting = true; dsh?.stop(); }
});
// Deliberately no native shutdown here: GUI lifecycle is independent of sessions.
app.on('will-quit', () => { queueDispatcher?.close(); });
// A session rotation is announced to the person; the space record and log keep the ids.
function notifyRotation(outcome, record) {
  const keys = { done: 'os.rotationDoneBody', kept: 'os.rotationKeptBody', failed: 'os.rotationFailedBody' };
  const notice = { key: keys[outcome], params: { old: record.name, new: record.newName || record.name, reason: record.reason || '' } };
  try {
    if (!Notification.isSupported()) {
      return;
    }
    const notification = new Notification({ title: displayText('os.rotationTitle'), body: displayText(notice.key, notice.params) });
    notification.once('click', () => focusOrOpen());
    notification.show();
  } catch {
    // The space record and the rotation log remain when OS delivery fails.
  }
}
