const { app, BrowserWindow, WebContentsView, ipcMain, dialog, Menu, clipboard, nativeImage, session, shell, screen, Notification, powerMonitor } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// The window loads app/dsh/client.js, which scripts/build-ui.cjs writes and Git
// ignores. A source checkout without it would open on "Failed to load plugins".
// Electron's isPackaged is a boolean; unit tests run this file with a fake app.
if (app.isPackaged === false && !fs.existsSync(path.join(__dirname, 'dsh', 'client.js'))) {
  console.error('app/dsh/client.js is missing: run `node scripts/build-ui.cjs` first (it is generated, not in Git). No window opened.');
  process.exit(1);
}
const { randomUUID } = require('node:crypto');
const { ensureService, connect, connectService, continuationStatus, continueService } = require('./service-client.cjs');
const { createReconnector, createEventLog } = require('./service-reconnect.cjs');
const { createStatePush } = require('./state-push.cjs');
const backendSwitch = require('./backend-switch.cjs');
const { startDsh, resetUiAuthentication } = require('./dsh-host.cjs');
const { startupMessage, uiError } = require('./ui-errors.cjs');
const uiLocale = require('./ui-locale.js');
const { preflight, appBuildInfo } = require('./preflight.cjs');
const { setLocation } = require('./runtime-locations.cjs');
const { pathToFileURL } = require('node:url');
const { submissionState, assertNativeCreation, capabilitiesFor } = require('./submission-policy.cjs');
const { leaveRecords, omitHidden, reportShown, validShown } = require('./shown-sessions.cjs');
const { searchRecords } = require('./renderer/local-search.js');
const { readPreview, saveCopy, extensions: textExtensions, openMessageFile } = require('./local-files.cjs');
const { createLocalPages } = require('./local-pages.cjs');
const { ImagePreviews, imageSource } = require('./native-images.cjs');
const { SessionLabels } = require('./session-labels.cjs');
const { RoomState } = require('./room-state.cjs');
const { QueueSecretary, follow: followRotation } = require('./queue-secretary.cjs');
const { IntegratorRole } = require('./integrator-role.cjs');
const { StewardRole, validDuty } = require('./steward-role.cjs');
const { StewardStanding } = require('./steward-standing.cjs');
let stewardStanding;
const stewardRecords = require('./steward-record.cjs');
const { StewardWake } = require('./steward-wake.cjs');
const { AnswerNotices } = require('./answer-notices.cjs');
const { VersionEvents, VersionNotices, RunMark } = require('./version-events.cjs');
const { QuietWindows } = require('./quiet-windows.cjs');
const { ButlerIngress, bindQueueOutcomes } = require('./butler-ingress.cjs');
const { ButlerLedger } = require('./butler-ledger.cjs');
const { ButlerReadAudit } = require('./butler-read-audit.cjs');
const { ButlerRole } = require('./butler-role.cjs');
const { ButlerPerson } = require('./butler-person.cjs');
const butlerEntryHost = require('./butler-entry-host.cjs');
const { displayCredentialPresent: butlerCredentialPresent } = require('./butler-presence.cjs');
const { showQuestionNotification } = require('./butler-question-notification.cjs');
const { createDedicatedBackend } = require('./butler-backend-host.cjs');
const { CreationDefaults } = require('./creation-defaults.cjs');
const { readingState } = require('./reading-state.cjs');
const { ViewStore, validViews, dropRetiredViewFields } = require('./view-store.cjs');
const { roomId: validRoomId, roomIds, untouchedDefault, placementRevision } = require('./collaboration-spaces.cjs');
const { identity: roomPeerIdentity } = require('./peer-handoffs.cjs');
const { PersonActions, asker } = require('./person-actions.cjs');
const { windowPlacement } = require('./window-placement.cjs');
const { backups, beginDraft, acknowledgeDraft, acceptSentDraft, forgetDraft, retainRecovery, discardRecovery } = require('./view-drafts.cjs');
const { createOutboxBroker } = require('./computer-use-outbox-broker.cjs');
const { bindOriginalOutbox, bindClaudeOutbox, bindOriginalControl, bindClaudeControl } = require('./computer-use-outbox-owner.cjs');
const { createStockOutboxView } = require('./computer-use-outbox-view.cjs');
const background = require('./background-control.cjs');
const recordReminders = require('./record-reminders.cjs');
const regularPopup = require('./regular-popup.cjs');
let discoveries;
const { inspectTextPaths, openTextPath } = require('./text-paths.cjs');
const { TempReminders, readSummary: readTempSummary, tempSummary } = require('./temp-reminders.cjs');
const confirmationInbox = require('./confirmation-inbox.cjs');
let tempReminders = null, tempRemindersTimer = null, tempQuitWaiting = false;
function currentTempReminders() {
  tempReminders ||= new TempReminders({ dataDir, isPerson: isCurrentHumanContext, changed: () => recordsChanged(true) });
  if (!tempRemindersTimer) { tempRemindersTimer = setInterval(() => tempReminders.status().catch(() => recordsChanged(true)), 86400000); tempRemindersTimer.unref(); }
  return tempReminders;
}
const backgroundOperation = require('./background-operation.cjs');
const queueRules = require('./queue-dispatch.cjs');
const { QueueDispatcher } = queueRules;
const applicationHandlers = new Map();
// Why background control did not load at start ('history': its blocks; 'other': anything else), for the bell.
let backgroundControl, backgroundUnavailable = false, operationsUnavailable = null, operationsBlocks = -1, stewardRecord = null, stewardOf = null;
// Waking the butler when NAW has recorded something new (steward-wake.cjs): off until the person or the butler turns it on.
let stewardWake = null;
let personActions = null;
function recordPersonAction(name, args, value) {
  try { personActions?.call(name, args, value); }
  catch { butlerIngress?.errors.set('person-actions', 'source-unavailable'); }
}
function observePersonActions(snapshot) {
  try { personActions?.observe(snapshot, backgroundControl?.data?.records || []); }
  catch { butlerIngress?.errors.set('person-actions', 'source-unavailable'); }
}
// The person's answers on agents' confirmation cards, owed to the agent that asked until the dispatcher tells it.
const answerNotices = new AnswerNotices();
const versionNotices = new VersionNotices();
let butlerClosing = false, butlerQuitAttempted = false;
let outboxBroker, outboxUnavailable = false, outboxClosing = false, outboxQuitFailed = false;

app.setName('Native Agent Workspace');
process.env.NAW_APP_VERSION = app.getVersion();
for (const flag of ['disable-background-networking', 'disable-component-update', 'disable-sync']) app.commandLine.appendSwitch(flag);
let vendorIcons;
function localVendorIcons() {
  return vendorIcons ||= require('./vendor-icons.cjs').loadVendorIcons(path.join(app.getPath('userData'), 'vendor-icons'));
}
const normalDataDir = app.getPath('userData');
if (process.env.NAW_DATA_DIR) app.setPath('userData', path.resolve(process.env.NAW_DATA_DIR));
// Headed test runs belong to their launcher, not to a forgotten background job.
// This is opt-in for the test command; normal desktop sessions have no parent lease.
const testParent = Number(process.env.NAW_TEST_PARENT_PID);
// Existing headed launchers supply both a real parent and a private profile.
// Set macOS activation policy before ready/window creation, not after firstWindow.
const testRequested = Object.hasOwn(process.env, 'NAW_TEST_PARENT_PID');
function normalProfileIdentity(target) {
  try { return fs.statSync(target); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}
function profileHasAncestor(identity, target) {
  let current = path.resolve(target);
  for (;;) {
    try {
      current = fs.realpathSync(current);
      const candidate = fs.statSync(current);
      if (!candidate.isDirectory()) throw Error('Profile ancestry is not a directory');
      if (candidate.dev === identity.dev && candidate.ino === identity.ino) return true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}
let backgroundTest = false;
if (testRequested) {
  try {
    if (app.commandLine.hasSwitch('user-data-dir')) throw Error('CLI userData overrides cannot request test permissions');
    const profile = process.env.NAW_DATA_DIR && fs.realpathSync(path.resolve(process.env.NAW_DATA_DIR));
    const info = profile && fs.statSync(profile);
    const normalReferences = [normalDataDir];
    if (process.platform === 'darwin') {
      // Electron's userData may move with a CLI override; HOME is also mutable.
      const home = os.userInfo().homedir;
      if (typeof home !== 'string' || !path.isAbsolute(home)) throw Error('OS account home is unavailable');
      normalReferences.push(path.join(home, 'Library', 'Application Support', app.getName()));
    }
    backgroundTest = /^\d+$/.test(process.env.NAW_TEST_PARENT_PID) && Number.isSafeInteger(testParent) && testParent > 1 && process.ppid === testParent && Boolean(profile) && normalReferences.every(reference => {
      const normalInfo = normalProfileIdentity(reference);
      return (!normalInfo || !profileHasAncestor(normalInfo, profile)) && !profileHasAncestor(info, reference);
    }) && info.isDirectory() && typeof process.getuid === 'function' && info.uid === process.getuid() && (info.mode & 0o077) === 0;
    if (backgroundTest) { app.setPath('userData', profile); app.setPath('sessionData', profile); }
  } catch { backgroundTest = false; /* An unverifiable profile must never fall through to foreground. */ }
  if (!backgroundTest) { console.error('Invalid isolated headed-test parent/profile; no window opened.'); process.exit(1); }
}
const butlerEntryEnabled = backgroundTest && process.env.NAW_TEST_BUTLER_ENTRY === '1';
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
// How this run ends is recorded from here on (version-events.cjs), as early as this run is known to be the only one.
let runMark = null;
if (primary) try {
  fs.mkdirSync(app.getPath('userData'), { recursive: true, mode: 0o700 });
  runMark = new RunMark(app.getPath('userData'), { version: app.getVersion() });
} catch { /* Without a mark of its own this run is told by what is left there, if anything. */ }
const windows = new Map();
const toolWaitNotifications = new Map();
const capacityNotifications = new Map();
const queueOutcomeSeen = new Set(), queueOutcomeNotifications = new Map();
let pendingReveal = null, backgroundNotifications = null, notificationScreen = null;
const confirmationProjectionKeys = new WeakMap();
let entry, dsh;
const trusted = url => { try { const parsed = new URL(url); return parsed.origin === dsh.origin && parsed.pathname === '/'; } catch { return false; } };
let dataDir, sessionLabels, roomState, queueSecretary, integratorRole, stewardRole, landingOwner = null, butlerIngress, butlerReadAudit = null, butlerBackend = null, creationDefaults, viewStore, viewStorageWarning = null, viewStorageWarningUiMessage = null, views = [], quitting = false;
let localPages = null;
let butlerRole = null, butlerPerson = null;
let startupWindow, starting = false, wired = false;
let applicationBuild, applicationMenu;
let mobileBroker;let mobileQuitWaiting=false,mobileQuitSettled=false;
let mobileListener, mobileOpening = false, mobileGeneration = 0, mobileStopped = Promise.resolve(true), mobileExpiry;
let mobileQrRequest=0;
// One status contract for the desktop bell, scoped phone reads and count push.
function confirmationSnapshot(client, snapshot = client.snapshot()) {
  return { ...snapshot, unavailable: Boolean(snapshot.unavailable || client.closing || client.socket?.destroyed ||
    client.entries?.some(e => e.closed || e.closing || e.client?.socket?.destroyed)) };
}
function appRecordsStatus(snapshot = null, suppliedTemp = null) {
  let standing = { rows: [], known: false }; try { standing = stewardStanding?.switches() ?? standing; } catch { /* The other reminders are shown. */ }
  const records = recordReminders.status(dataDir, Date.now(), { standing, unavailable: {
    ...(operationsUnavailable ? { operations: operationsUnavailable } : {}),
    ...(stewardRecord?.failed ? { steward: stewardRecord.loadError ? 'history' : 'other' } : {}),
  } });
  let temp;
  try { temp = suppliedTemp ? tempSummary(suppliedTemp) : tempReminders?.cached ? tempSummary(tempReminders.cached) : readTempSummary(dataDir); }
  catch { temp = { id: 'naw-temp-files', version: 0, state: 'unavailable', checkedAt: Date.now(), directories: 0, bytes: 0, oldestDay: null, shown: true, result: null }; }
  const names = snapshot && sessionLabels.apply(roomState.apply(snapshot));
  const cards = snapshot?.backgroundConfirmations || (backgroundControl && names ? backgroundControl.confirmations(names, snapshot) : []);
  let health;
  try { health = require('./mobile-workspace.cjs').healthSummary(stewardWake?.view(), require('./steward-wake.cjs').BLOCK_REASONS); }
  catch { health = { available: false, alerts: [] }; }
  return { ...confirmationInbox.inboxStatus(records, temp, cards.map(confirmationInbox.confirmationSummary)), health };
}
// The one list of fixed alert codes for the phone, shared by its push and its banner: no names, text, counts or
// error messages. unknown lists the codes whose source could not be read; available false means some are unknown,
// never "no problems". A lost service is added where it is seen.
// at is when the newest case began, so that a second question is announced while the first is still open.
// status is the shared reminder status when the caller may read it; without it the cards were not judged.
function appHealth(status = null) {
  const alerts = [], unknown = [];
  try { if (stewardWake?.view().blocked) alerts.push({ code: 'steward-wake-stalled' }); } catch { unknown.push('steward-wake-stalled'); }
  try {
    const rooms = [roomState.value, ...roomState.spaces.rooms];
    // The same rule as the desktop's decision notification: waiting with no reason asks the person.
    const asked = rooms.filter(room => !room.archived).flatMap(room => (room.queue || []).filter(item => item.status === 'waiting' && !item.reason));
    const cards = (status?.confirmations || []).filter(card => card.actionable === true);
    if (asked.length || cards.length) alerts.push({ code: 'decision-waiting', at: Math.max(0,
      ...asked.map(item => Number.isSafeInteger(item.finishedAt) ? item.finishedAt : 0), ...cards.map(card => Number.isSafeInteger(card.time) ? card.time : 0)) });
    else if (!status) unknown.push('decision-waiting');
  } catch { unknown.push('decision-waiting'); }
  return { available: !unknown.length, alerts, unknown };
}
function appMobileBroker() {
  if (!primary || quitting || mobileQuitWaiting || !dataDir) throw Error('The local mobile entry is unavailable.');
  if (!mobileBroker) {
    const {PairingStore,keychainAdapter}=require('./mobile-pairing-store.cjs');
    const adapter=keychainAdapter();
    mobileBroker = new (require('./mobile-broker.cjs').MobileBroker)(dataDir, { exclusive: () => primary && !quitting && !mobileQuitWaiting, changed: () => watchAppMobile(MOBILE_RESPONSE_GRACE_MS), desktop: appMobileWorkspace(), onHumanInput: id => queueDispatcher?.noteHuman(id),persistence:new PairingStore(dataDir,{adapter,asynchronous:true,log:({phase,category,elapsedMs})=>appMobileLog(phase,category,elapsedMs)}),
      pushOptions: { adapter, alerts: status => appHealth(status) } });
  }
  return mobileBroker;
}
function appMobileWorkspace() {
  return new (require('./mobile-workspace.cjs').MobileWorkspace)({
    snapshot: client => displayState(confirmationSnapshot(client)), roomState, labels: sessionLabels.labels,
    records: {
      status: (state, client) => appRecordsStatus(state || (client && confirmationSnapshot(client))),
      acknowledge: (...args) => { const result = recordReminders.acknowledge(dataDir, ...args); mobileBroker?.refreshPush(); return result; },
    },
    confirmation: (...args) => backgroundControl.mobileBinding(...args), decide: (...args) => backgroundControl.decide(...args),
    broadcast: () => broadcastRoom(), schedule: () => queueDispatcher?.schedule(),
    personAction: recordPersonAction,
    // The same designation the Mac sidebar shows; before it is read, the phone says unavailable, not none.
    steward: () => { if (!stewardRole) throw Error('Butler designation not read yet'); return stewardRole.current() || null; },
  });
}
// The listener stays open only while a pairing link or paired device is unexpired. When the phone logs out, or the link
// or device expires, NAW revokes and closes it. A logout closes it only after its own response has had time to leave.
// Waits are at most a minute and each check re-reads the stored state, so sleep or a clock change delays closing by
// at most that minute. A check belongs to the pairing it was set for: a newer pairing or revoke makes it a no-op.
const MOBILE_RESPONSE_GRACE_MS = 1000, MOBILE_CHECK_MS = 60000;
function watchAppMobile(grace = 0) {
  clearTimeout(mobileExpiry); mobileExpiry = undefined;
  if (!mobileListener || !mobileBroker) return;
  const generation = mobileGeneration, current = () => generation === mobileGeneration && !mobileOpening && mobileListener;
  const until = mobileBroker.openUntil();
  if (!until) { mobileExpiry = setTimeout(() => { mobileExpiry = undefined; if (!current()) return; if (!mobileBroker.openUntil()) revokeAppMobile(); else watchAppMobile(); }, grace); return; }
  mobileExpiry = setTimeout(() => { mobileExpiry = undefined; if (current()) watchAppMobile(); }, Math.min(MOBILE_CHECK_MS, Math.max(0, until - Date.now()) + 1));
}
function stopAppMobileListener() {
  const entry = mobileListener; mobileListener = null;
  if (!entry) return;
  mobileStopped = new Promise(resolve => {
    let clean = true;
    try { entry.controller.abort(); } catch { clean = false; }
    try { entry.server.close(error => resolve(clean && (!error || error.code === 'ERR_SERVER_NOT_RUNNING'))); }
    catch { clean = false; resolve(false); }
    // Only this explicitly enabled app-owned HTTP server is affected. Native
    // services and work already committed through Unix are independent.
    try { entry.server.closeAllConnections(); } catch { clean = false; resolve(false); }
  });
}
async function beginAppMobile(options) {
  const keys = ['actor', 'origin', 'selection', 'replace', 'port', 'carrierConfirmed'];
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => ![...keys, 'workspace', 'all','sharedHostConfirmed'].includes(key)) || keys.some(key => !Object.hasOwn(options, key)) || options.all !== undefined && typeof options.all !== 'boolean' || options.sharedHostConfirmed !== undefined && typeof options.sharedHostConfirmed !== 'boolean' ||
      options.carrierConfirmed !== true || !Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535 || options.port !== 0 && options.port < 1024 || mobileOpening) throw Error('Mobile setup is unavailable or incomplete.');
  const broker = appMobileBroker(), handler = require('./mobile-http.cjs').createMobileHandler({ broker, origin: options.origin, actor: options.actor });
  const generation = ++mobileGeneration; mobileOpening = true; let authorityChanged = false;
  try {
    const challenge = await broker.beginPairing({ actor: options.actor, origin: options.origin, selection: options.all ? undefined : options.selection, replace: options.replace,
      ...(options.all ? { all: true } : {}),
      ...(Object.hasOwn(options, 'workspace') ? { workspace: options.workspace } : {}) });
    authorityChanged = true;
    if (generation !== mobileGeneration || quitting) throw Error('Mobile setup cancelled.');
    stopAppMobileListener();
    if (!await mobileStopped || generation !== mobileGeneration || quitting) throw Error('Previous mobile listener close is unconfirmed.');
    const entry=await startAppMobileListener(options,handler,generation),address=entry.server.address();watchAppMobile();
    return { ...challenge, localAddress: `http://127.0.0.1:${address.port}/mobile/` };
  } catch {
    // A newer explicit revoke owns the newer state; never revoke its successor.
    if (authorityChanged && generation === mobileGeneration) revokeAppMobile();
    // A refused or failed re-pairing may already have revoked the old grant: close the old listener if nothing is open.
    else if (generation === mobileGeneration) watchAppMobile();
    throw uiError('error.mobile.connectUnavailable');
  } finally { mobileOpening = false; }
}
async function startAppMobileListener(options,handler,generation) {
  const controller=new AbortController(),server=require('node:http').createServer({maxHeaderSize:8192},handler);
  const entry={server,controller,ready:false,origin:options.origin,actor:options.actor};mobileListener=entry;
  server.maxConnections=8;server.maxRequestsPerSocket=16;server.headersTimeout=5000;server.requestTimeout=5000;server.keepAliveTimeout=1000;
  server.on('error',()=>{if(entry.ready && mobileListener===entry)revokeAppMobile();});
  await new Promise((resolve,reject)=>{
    server.once('error',error=>reject(Object.assign(Error('Mobile listener unavailable.'),{listenCode:error?.code})));server.once('close',()=>reject(Error('Mobile listener cancelled.')));
    try{server.listen({host:'127.0.0.1',port:options.port,exclusive:true,signal:controller.signal},resolve);}catch(error){reject(error);}
  });
  if(generation!==mobileGeneration || quitting || mobileListener!==entry || controller.signal.aborted)throw Error('Mobile setup cancelled.');
  const address=server.address();if(!address || address.address!=='127.0.0.1' || !Number.isSafeInteger(address.port))throw Error('Mobile listener binding unconfirmed.');
  let binding=require('./mobile-carrier.cjs').binding(options)||options.binding||null;
  if(!binding&&options.carrierConfirmed)try{
    const fresh=await require('./mobile-carrier.cjs').detect({port:address.port,sharedHostConfirmed:options.sharedHostConfirmed===true});
    if(fresh.origin===options.origin&&fresh.actor===options.actor)binding=require('./mobile-carrier.cjs').binding(fresh);
  }catch{ /* A manually verified legacy entry is not automatic recovery proof. */ }
  if(generation!==mobileGeneration||quitting||mobileListener!==entry||controller.signal.aborted)throw Error('Mobile setup cancelled.');
  mobileBroker?.setEndpoint?.({origin:options.origin,actor:options.actor,port:address.port,binding});
  entry.ready=true;return entry;
}
async function resumeAppMobile(context,value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1||typeof value.sharedHostConfirmed!=='boolean'||!primary||quitting||mobileOpening)throw uiError('error.mobile.carrierUnavailable');
  const broker=appMobileBroker();await broker.preparePersistence?.(context?'restore':'boot');if(!primary||quitting||mobileOpening||context&&!isCurrentHumanContext(context))throw uiError('error.mobile.carrierUnavailable');const endpoint=broker.resumeInfo();if(!endpoint)throw uiError('error.mobile.carrierUnavailable');
  const generation=++mobileGeneration,request=++mobileQrRequest;mobileOpening=true;let currentEndpoint;if(!context)mobileBootGeneration=generation;
  const current=()=>generation===mobileGeneration&&request===mobileQrRequest&&!quitting&&primary&&(!context||isCurrentHumanContext(context));
  const validate=async()=>{
    const carrier=context?await detectAppMobile({view:{mobileEndpoint:{port:endpoint.port}}},value):
      await require('./mobile-carrier.cjs').detectRestored(endpoint.binding);
    const binding=require('./mobile-carrier.cjs').binding(carrier);
    if(!current()||!require('./mobile-carrier.cjs').sameBinding(binding,endpoint.binding)||carrier.origin!==endpoint.origin||carrier.actor!==endpoint.actor||carrier.port!==endpoint.port)return false;
    currentEndpoint={origin:carrier.origin,actor:carrier.actor,port:carrier.port,binding};broker.setEndpoint(currentEndpoint);return true;
  };
  try{
    if(!await validate()||mobileListener||!await mobileStopped)throw uiError('error.mobile.carrierUnavailable');
    await startAppMobileListener(currentEndpoint,require('./mobile-http.cjs').createMobileHandler({broker,origin:endpoint.origin,actor:endpoint.actor}),generation);
    const result=await broker.resume(validate);if(!current())throw uiError('error.mobile.carrierUnavailable');
    return result;
  }catch(error){if(generation===mobileGeneration){try{broker.suspend();}finally{stopAppMobileListener();}}throw error;}
  finally{mobileOpening=false;watchAppMobile();}
}
function appMobileLog(phase,category,elapsedMs){
  const entry={phase,category,elapsedMs};try{require('./mobile-pairing-store.cjs').logPairing?.(dataDir,entry);}catch{}
  console.warn(`[mobile-pairing] ${phase} ${category} ${elapsedMs}ms`);
}
// After an outage Tailscale can come up after NAW. Only "not ready yet" is retried, with the full checks each time and
// capped exponential backoff (5 s doubling to 1 min); a pairing action, revoke or quit since the attempt cancels it.
const MOBILE_RESUME_DELAYS=[5000,10000,20000,40000,60000];
let mobileResumeRetry,mobileResumeNow,mobileResumeState=null,mobileBootGeneration=0;
function mobileResumeReason(error){
  const blocked=mobileBroker?.resumeBlocker?.();
  if(blocked)return blocked;
  if(error?.carrierNotReady)return 'not-ready';
  if(error?.listenCode==='EADDRINUSE')return 'port-in-use';
  if(['MOBILE_CARRIER_UNAVAILABLE','MOBILE_SHARED_HOST'].includes(error?.code))return 'changed';
  return 'other';
}
async function resumeAppMobileOnBoot(attempt=0){
  clearTimeout(mobileResumeRetry);mobileResumeRetry=mobileResumeNow=undefined;
  if(!fs.existsSync(path.join(dataDir,'mobile-authority.json')))return;
  const started=Date.now(),before=mobileGeneration,previous=attempt?mobileResumeState?.reason:undefined;
  try{
    await resumeAppMobile(null,{sharedHostConfirmed:false});
    mobileResumeState=null;
    if(attempt)appMobileLog('boot-retry','ok',Math.max(0,Date.now()-started));
  }catch(error){
    // Anything past the generation this attempt took (or the one before it, if it failed first) is a newer action by the person.
    if(mobileGeneration>Math.max(before,mobileBootGeneration)||mobileBootGeneration>before+1||quitting)return;
    let reason='other',port;
    try{reason=mobileResumeReason(error);port=mobileBroker?.resumeInfo?.()?.port;}catch{}
    const generation=mobileGeneration;
    mobileResumeState={reason,generation,port};
    if(reason!==previous)appMobileLog(attempt?'boot-retry':'boot',reason==='other'?'unavailable':reason,Math.max(0,Date.now()-started));
    if(reason!=='not-ready')return;
    const run=next=>{
      mobileResumeRetry=mobileResumeNow=undefined;
      if(generation===mobileGeneration&&!quitting&&primary&&!mobileOpening&&!mobileListener)resumeAppMobileOnBoot(next).catch(()=>{});
    };
    mobileResumeNow=run;
    mobileResumeRetry=setTimeout(()=>run(attempt+1),MOBILE_RESUME_DELAYS[Math.min(attempt,MOBILE_RESUME_DELAYS.length-1)]);
  }
}
// On wake a pending retry runs at once and its backoff starts over, as browsers retry when they come back online.
function wakeAppMobileResume(){
  if(!mobileResumeRetry)return;
  clearTimeout(mobileResumeRetry);mobileResumeNow(1);
}
function appMobileApprovalStatus(value){
  const status=appMobileBroker().approvalStatus(value),s=mobileResumeState;
  // The broker states saved-pairing reasons itself, live; only reasons it cannot see are remembered here.
  if(!status.resumeRequired||!s||s.generation!==mobileGeneration||!['not-ready','port-in-use','other','changed'].includes(s.reason))return status;
  if(s.reason==='changed')return {...status,resumeRequired:false,reconnectRequired:true,resumeReason:'changed'};
  return {...status,resumeReason:s.reason,...(s.reason==='port-in-use'&&s.port?{resumePort:s.port}:{})};
}
function suspendAppMobile(){
  mobileGeneration++;mobileQrRequest++;clearTimeout(mobileExpiry);mobileExpiry=undefined;
  try{return mobileBroker?.suspend();}finally{stopAppMobileListener();}
}
async function beginQrAppMobile(carrier,replace,validate,renewal={}) {
  if(mobileOpening)throw Error('Mobile setup unavailable');const started=Date.now(),broker=appMobileBroker(),existing=mobileListener;
  if(existing && (!existing.ready || existing.origin!==carrier.origin || existing.actor!==carrier.actor || existing.server.address()?.port!==carrier.port))throw Error('Existing mobile entry differs');
  let generation=renewal.renew?mobileGeneration:++mobileGeneration;mobileOpening=true;let result;
  try {
    result=await broker.beginCandidate({actor:carrier.actor,origin:carrier.origin,replace,validate,endpoint:{...carrier,binding:require('./mobile-carrier.cjs').binding(carrier)},...renewal});
    if(generation!==mobileGeneration || quitting)throw Error('Mobile setup cancelled');
    if(renewal.renew)generation=++mobileGeneration;
    if(!existing){if(!await mobileStopped || mobileListener)throw Error('Mobile entry close unconfirmed');await startAppMobileListener(carrier,require('./mobile-http.cjs').createMobileHandler({broker,origin:carrier.origin,actor:carrier.actor}),generation);}
    return result;
  }catch(error){if(result)broker.cancelCandidate(result.id,{unredeemedOnly:true});if(!broker.openUntil())stopAppMobileListener();if(error.code==='MOBILE_SETUP_REDEEMED')throw uiError('error.mobile.enrollmentActive');appMobileLog('pair','unconfirmed',Math.max(0,Date.now()-started));throw uiError('error.mobile.connectUnavailable');}
  finally{mobileOpening=false;watchAppMobile();}
}
async function detectAppMobile(context, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'sharedHostConfirmed') || typeof value.sharedHostConfirmed !== 'boolean') throw uiError('error.mobile.carrierUnavailable');
  const savedPort = Number(context.view?.mobileEndpoint?.port);
  const rememberedPort = Number.isSafeInteger(savedPort) && savedPort >= 1024 && savedPort <= 65535 ? savedPort : 48765;
  try { return await require('./mobile-carrier.cjs').detect({ port: rememberedPort, sharedHostConfirmed: value.sharedHostConfirmed }); }
  catch (error) {
    if (error.code !== 'MOBILE_SHARED_HOST') throw uiError('error.mobile.carrierUnavailable');
    const ports=Array.isArray(error.otherPorts)?[...new Set(error.otherPorts.filter(p=>Number.isSafeInteger(p)&&p>0&&p<=65535))].slice(0,32):[];
    throw uiError(ports.length?'error.mobile.sharedHostPorts':'error.mobile.sharedHost',ports.length?{ports:ports.join(', ')}:undefined);
  }
}
async function connectAppMobile(context, value) {
  if(!value || typeof value!=='object' || Array.isArray(value) || !Object.hasOwn(value,'sharedHostConfirmed') || Object.keys(value).some(k=>!['sharedHostConfirmed','replace','renew','refreshOf','automatic'].includes(k)) || value.replace!==undefined && (!Object.hasOwn(value,'replace') || typeof value.replace!=='boolean'))throw uiError('error.mobile.carrierUnavailable');
  if (value.renew!==undefined && value.renew!==true || value.refreshOf!==undefined && (!validMobileSetupId(value.refreshOf) || value.renew!==true) || value.automatic!==undefined && (value.automatic!==true || !value.refreshOf)) throw uiError('error.mobile.carrierUnavailable');
  const renewal=value.renew?{renew:true,...(value.refreshOf?{refreshOf:value.refreshOf}:{}),...(value.automatic?{automatic:true}:{})}:{};
  const detection={sharedHostConfirmed:value.sharedHostConfirmed},request=++mobileQrRequest;
  const carrier = await detectAppMobile(context, detection);
  // No renderer-supplied address, login, scope list, or arbitrary listener port.
  if(request!==mobileQrRequest)throw uiError('error.mobile.carrierUnavailable');
  let generation=mobileGeneration;
  const validate=async()=>{const fresh=await detectAppMobile(context,detection);return JSON.stringify(carrier)===JSON.stringify(fresh) &&
    JSON.stringify(require('./mobile-carrier.cjs').binding(carrier))===JSON.stringify(require('./mobile-carrier.cjs').binding(fresh)) &&
    generation===mobileGeneration && !quitting && primary && isCurrentHumanContext(context);};
  const result=await beginQrAppMobile(carrier,value.replace===true,validate,renewal);generation=mobileGeneration;context.mobileSetupId=result.id;
  try {
    if(request!==mobileQrRequest || !await validate())throw Error('Changed mobile carrier');
    const qr = await require('./mobile-qr.cjs').generate(carrier.origin + '/mobile/#pair=' + result.secret);
    if (generation !== mobileGeneration || result.expiresAt <= Date.now() || quitting || !primary || !isCurrentHumanContext(context)) throw Error('Expired local code');
    return { qr, expiresAt: result.expiresAt,setupId:result.id };
  } catch {
    const broker=appMobileBroker();broker.cancelCandidate(result.id,{unredeemedOnly:true});if(!broker.openUntil())stopAppMobileListener();watchAppMobile(MOBILE_RESPONSE_GRACE_MS);
    throw uiError('error.mobile.carrierUnavailable');
  }
}
function validMobileSetupId(id) { return typeof id==='string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id); }
function appMobileSetupStatus(_context,value) {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).length!==1 || !validMobileSetupId(value.setupId))throw uiError('error.mobile.carrierUnavailable');
  return mobileBroker?mobileBroker.candidateInfo(value.setupId):{state:'unconfirmed'};
}
function cancelAppMobileSetup(_context,value) {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).length!==1 || !Object.hasOwn(value,'setupId') || typeof value.setupId!=='string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.setupId))throw uiError('error.mobile.carrierUnavailable');
  if(!mobileBroker)return {cancelled:false};const result=mobileBroker.cancelCandidate(value.setupId,{unredeemedOnly:true});
  if(result.cancelled){mobileGeneration++;mobileQrRequest++;watchAppMobile(MOBILE_RESPONSE_GRACE_MS);}return result;
}
function closeAppMobileSetup(context) {
  const id=context.mobileSetupId;context.mobileSetupId=null;
  if(id)try{cancelAppMobileSetup(context,{setupId:id});}catch{}
}
function revokeAppMobile() {
  const started=Date.now();
  mobileGeneration++;mobileQrRequest++; clearTimeout(mobileExpiry); mobileExpiry = undefined;
  let result = { authorizationRevoked: true, connectionClosed: true, committedWorkMayContinue: false };
  if (mobileBroker) {
    try { result = mobileBroker.revoke(); }
    catch { result = { authorizationRevoked: false, connectionClosed: false, committedWorkMayContinue: true }; }
  }
  // A transport-close fault must never skip durable authorization revocation.
  try { stopAppMobileListener(); } catch { mobileStopped = Promise.resolve(false); }
  const finish=value=>{if(value.authorizationRevoked!==true)appMobileLog('revoke','unconfirmed',Math.max(0,Date.now()-started));return value;};
  return result?.then?result.then(finish,()=>finish({authorizationRevoked:false,connectionClosed:false,committedWorkMayContinue:true})):finish(result);
}
const startupFile = path.join(__dirname, 'startup.html');
let localeSnapshot = uiLocale.snapshot({ languages: [], preference: null });
let localeProvisional, localeWarning = null, localeHostGeneration = 0;
const displayLanguage = () => localeProvisional || uiLocale.language(localeSnapshot);
const displayText = (key, params) => uiLocale.format(displayLanguage(), key, params);
function broadcastLocale() {
  const targets = new Set([startupWindow, ...[...windows.values()].filter(c => !c.background).map(c => c.win)]);
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
function switchWindowMode(mode, win = BrowserWindow.getFocusedWindow()) {
  if (!workspaceMenuReady() || !['chat', 'terminal'].includes(mode)) return;
  const context = win && windows.get(win.webContents.id);
  if (context && context.win === win) {
    localPages?.workspace(context);
    sendToPage(context, 'workspace:switch-mode', mode);
  }
}
function updateApplicationMenu() {
  const text = key => displayText(key, { app: app.name });
  const create = !applicationMenu;
  const menu = applicationMenu ||= Menu.buildFromTemplate([
    { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { id: 'naw-menu-quit', label: text('menu.quit'), accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }] },
    { id: 'naw-menu-file', label: text('menu.file'), submenu: [{ id: 'naw-menu-new-window', label: text('menu.newWindow'), accelerator: 'CmdOrCtrl+Shift+N', click: () => { if (workspaceMenuReady()) return openWindow(); } }, { id: 'naw-menu-new-session', label: text('menu.newSession'), accelerator: 'CmdOrCtrl+N', click: () => { if (!workspaceMenuReady()) return; const win = BrowserWindow.getFocusedWindow(); if (win && windows.get(win.webContents.id)?.win === win) win.webContents.send('workspace:new'); } }, { role: 'close' }] },
    { role: 'editMenu' }, { id: 'naw-menu-view', label: text('menu.view'), submenu: [{ id: 'naw-menu-chat', label: text('view.chat'), click: (_item, win) => switchWindowMode('chat', win) }, { id: 'naw-menu-terminal', label: text('view.native'), click: (_item, win) => switchWindowMode('terminal', win) }, { type: 'separator' }, { role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] }, { role: 'windowMenu' },
  ]);
  // Keep Electron's generated actions/accelerators and native window/Services
  // contents. Relabel only known application-owned standard role labels.
  const roles = { about: 'about', hide: 'hide', hideothers: 'hideOthers', unhide: 'unhide', close: 'close', editmenu: 'edit', undo: 'undo', redo: 'redo', cut: 'cut', copy: 'copy', paste: 'paste', pasteandmatchstyle: 'pasteAndMatchStyle', delete: 'delete', selectall: 'selectAll', reload: 'reload', forcereload: 'forceReload', resetzoom: 'resetZoom', zoomin: 'zoomIn', zoomout: 'zoomOut', togglefullscreen: 'togglefullscreen', windowmenu: 'window', minimize: 'minimize', zoom: 'zoom', front: 'front', services: 'services', speech: 'speech', startspeaking: 'startSpeaking', stopspeaking: 'stopSpeaking' };
  const own = { 'naw-menu-quit': 'quit', 'naw-menu-file': 'file', 'naw-menu-new-window': 'newWindow', 'naw-menu-new-session': 'newSession', 'naw-menu-view': 'view' };
  const relabel = current => { for (const item of current.items || []) { const role = item.role?.toLowerCase(); const key = Object.hasOwn(own, item.id) ? own[item.id] : Object.hasOwn(roles, role) ? roles[role] : undefined; if (key) item.label = text(`menu.${key}`); if (item.id === 'naw-menu-chat') item.label = text('view.chat'); if (item.id === 'naw-menu-terminal') item.label = text('view.native'); if (['naw-menu-new-window', 'naw-menu-new-session', 'naw-menu-chat', 'naw-menu-terminal'].includes(item.id)) item.enabled = workspaceMenuReady(); if (item.submenu) relabel(item.submenu); } };
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
        recovery.attempt !== 3 || !['capacity', 'routing', 'forbidden', 'connection'].includes(recovery.reason)) continue;
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
// B5: a session created under a grant in which the person named a space joins that space and is recorded there,
// so that queued work reaches it. The quota gate already ran in the backend (operator-control.cjs): nothing here
// creates a session, widens a grant, queues a task or asks a model. Where the session goes is read from the
// journal that owns the action, which refuses once the grant is no longer in force. Run only from a person's
// window, never from an agent's hidden one. A space that is busy is tried again, a few times, seconds apart.
const openPlacing = new Set(), openAttempts = new Map(), OPEN_RETRY_MS = [2000, 5000, 15000, 30000], OPEN_FORGET_MS = 60000;
async function placeOpened(client, snapshot, now = Date.now()) {
  const placements = Array.isArray(snapshot?.operatorPolicy?.placements) ? snapshot.operatorPolicy.placements : [];
  // A placement that is no longer listed is settled or its grant ended: its retry count is not kept. Only a
  // minute after its last delay, so a state that lacks it for a moment (another window, a backend
  // reconnecting) does not restart the tries.
  for (const [key, tried] of [...openAttempts]) if (!openPlacing.has(key) && now - tried.next > OPEN_FORGET_MS && !placements.some(listed => listed?.key === key)) openAttempts.delete(key);
  for (const listed of placements) {
    const key = listed?.key, tried = openAttempts.get(key);
    if (typeof key !== 'string' || typeof listed.initiatorId !== 'string' || openPlacing.has(key) || tried && (tried.over || now < tried.next)) continue;
    openPlacing.add(key);
    const call = (action, value) => client.call('operatorAction', listed.initiatorId, action, { key, ...value });
    let space = null, joined = false, names = null, answered = false;
    try {
      const placement = await call('placement');
      answered = true;
      if (placement.placed) continue;
      const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
      const opened = sessions.find(s => s.id === placement.sessionId), initiator = sessions.find(s => s.id === listed.initiatorId);
      const label = s => sessionLabels.labels.get(s.id) || s.name || s.id;
      let room = null;
      try { room = roomState.metadata(placement.space); } catch { /* No such space any more. */ }
      if (!room || room.archived) { await call('placed', { result: { joined: false, error: 'space-unavailable' } }); continue; }
      // Archiving is the desktop's own list; the backend does not know it.
      const archived = id => roomState.value.archivedSessions.includes(id);
      if (!opened || !initiator || ['ended', 'recoverable'].includes(opened.state) || archived(opened.id)) { await call('placed', { result: { joined: false, error: 'session-unavailable' } }); continue; }
      if (archived(initiator.id)) { await call('placed', { result: { joined: false, error: 'initiator-archived' } }); continue; }
      space = placement.space; names = { sessionId: opened.id, name: label(opened), initiator: label(initiator), initiatorId: initiator.id };
      // The person may have put it somewhere else meanwhile: a session that already has another home is left there.
      const homes = roomIds(opened);
      if (homes.length && !homes.includes(space)) {
        roomState.recordOpened(space, { ...names, joined: false });
        await call('placed', { result: { joined: false, error: 'moved-elsewhere' } }); await broadcastRoom(); continue;
      }
      // Already a member (an earlier attempt joined it): do not join again. Otherwise join with the placement this
      // state showed, so a move the person makes in between fails this join and is not undone by it.
      if (!homes.includes(space)) {
        await roomState.membership(client, opened.id, true, sessionLabels.labels.get(opened.id), space,
          { nativeId: opened.nativeId ?? null, placementRevision: placementRevision(opened), connectionRevision: opened.connectionRevision || 0 });
      }
      joined = true;
      roomState.recordOpened(space, { ...names, joined: true });
      await call('placed', { result: { joined: true } });
      openAttempts.delete(key);
      await broadcastRoom(); queueDispatcher?.schedule();
    } catch {
      const attempts = (tried?.attempts || 0) + 1, over = attempts > OPEN_RETRY_MS.length, wait = OPEN_RETRY_MS[attempts - 1] || 0;
      openAttempts.set(key, { attempts, next: now + wait, over });
      // One timer per retry, so a quiet system still tries again; nothing polls. It uses whichever of the
      // person's windows is open then: the window this attempt ran in may be closed or reconnected by that time.
      if (!over) setTimeout(() => {
        const live = [...windows.values()].find(c => !c.background && c.client && !c.win.isDestroyed() && !c.client.closing && !c.client.socket?.destroyed);
        // Reading the state can throw (two backends listing one session); inside the chain it cannot escape the timer.
        if (live) Promise.resolve().then(() => placeOpened(live.client, live.client.snapshot())).catch(() => {});
      }, wait + 100).unref?.();
      if (over) {
        // Said once, where the person can see it, and saved; after that nothing more is tried.
        // Only when the journal offered it: a refusal there (the grant ended) is not a failed join and saves nothing.
        try { if (space && names && !joined) roomState.recordOpened(space, { ...names, joined: false }); } catch { /* The space cannot take a record now. */ }
        if (answered) await call('placed', { result: joined ? { joined: true, error: 'record-failed' } : { joined: false, error: 'join-refused' } }).catch(() => {});
        await broadcastRoom().catch(() => {});
      }
    } finally { openPlacing.delete(key); }
  }
}
// B5: after NAW replaced a session, the person's creation grant goes with it, one finished replacement at a
// time. The backend lists holders whose session has ended. This step looks in the rotation log for the one
// unambiguous successor (the rule the secretary, integrator and steward designations follow) and names it to
// the backend that owns the journal, which checks the rest and re-binds the grant or saves why it did not;
// what only the desktop can see (an ambiguous log, an archived successor) it reports as a refusal. The
// outcome is final there. A holder stays listed until the person can read the outcome in a space, so a
// notice that could not be written is written later, and one that was written is never contradicted.
const grantCarrying = new Set(), grantChecked = new Map(), GRANT_RETRY_MS = 30000;
async function carryGrants(client, snapshot, now = Date.now()) {
  const listed = Array.isArray(snapshot?.operatorPolicy?.successions) ? snapshot.operatorPolicy.successions : [];
  for (const id of [...grantChecked.keys()]) if (!grantCarrying.has(id) && !listed.some(holder => holder?.id === id)) grantChecked.delete(id);
  for (const holder of listed) {
    if (typeof holder?.id !== 'string' || typeof holder.nativeId !== 'string' || grantCarrying.has(holder.id)) continue;
    const logFile = path.join(dataDir, 'rotation-log.jsonl');
    let stamp = 'none';
    try { const stat = fs.statSync(logFile); stamp = `${stat.size}:${stat.mtimeMs}`; } catch { /* No rotation has been logged. */ }
    const seen = `${holder.nativeId}\n${stamp}`, checked = grantChecked.get(holder.id);
    // Nothing to decide for this state of the log; or something failed, and it is tried again half a minute later.
    if (checked && (checked.retryAt ? now < checked.retryAt : checked.seen === seen)) continue;
    grantCarrying.add(holder.id);
    const call = value => client.call('operatorAction', holder.id, 'succession', { nativeId: holder.nativeId, ...value });
    const nothing = () => grantChecked.set(holder.id, { seen });
    try {
      const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
      let outcome = holder.outcome && typeof holder.outcome === 'object' ? holder.outcome : null, next = null;
      // A log that cannot be read decides nothing; it is read again when it changes.
      try { next = followRotation(logFile, { sessionId: holder.id, nativeId: holder.nativeId }); } catch { if (!outcome) { nothing(); continue; } }
      if (!outcome) {
        // Stopped by the person, not replaced: nothing to carry and nothing to say.
        if (!next.replaced) { nothing(); continue; }
        const target = next.sessionId === holder.id ? null : sessions.find(s => s.id === next.sessionId);
        // Replaced, but not by one finished, unambiguous successor; or by one the person has archived, which
        // only the desktop knows. The grant stays where it was.
        const answer = next.sessionId === holder.id ? await call({ step: 'refuse', reason: 'ambiguous', loggedAt: next.at })
          : !target || roomState.value.archivedSessions.includes(target.id) ? await call({ step: 'refuse', reason: 'successor-unavailable', loggedAt: next.at })
            : await call({ step: 'carry', to: { id: next.sessionId, nativeId: next.nativeId }, loggedAt: next.at });
        if (!answer || typeof answer.carried !== 'boolean') throw Error('Unexpected succession result');
        // No longer a holder, or running again: nothing was decided and there is nothing to say.
        if (answer.saved !== true) { nothing(); continue; }
        outcome = answer;
      }
      if (typeof outcome.carried !== 'boolean' || !Number.isSafeInteger(outcome.at)) throw Error('Unexpected succession outcome');
      // Said where the successor is; failing that, where the replacement was recorded; failing that, in the default space.
      const label = (id, fallback) => sessionLabels.labels.get(id) || sessions.find(s => s.id === id)?.name || fallback || id;
      const heir = outcome.carried ? sessions.find(s => s.id === outcome.to?.id) : null, rooms = new Set();
      try { for (const room of heir ? roomIds(heir) : []) rooms.add(room); } catch { /* Unreadable membership: fall back to where the replacement was recorded. */ }
      if (!rooms.size) for (const room of next?.spaces || []) rooms.add(room);
      if (!rooms.size) rooms.add('shared');
      // How many of the grants that went with it are in force as the notice is written. A revoked or expired
      // grant is carried as it is, and the notice must not read as if a usable grant had moved.
      const grants = Array.isArray(snapshot.operatorPolicy?.domains) ? snapshot.operatorPolicy.domains : [];
      const moved = outcome.carried ? grants.filter(domain => domain?.carried?.some(c => c?.from?.id === holder.id && c.from.nativeId === holder.nativeId && c.to?.id === outcome.to.id)) : [];
      // A holder listed with its outcome was decided before this state was taken, so the state shows the move.
      // One decided in this pass comes with a state from before the carry, where the grants are still the old
      // session's. (Told apart this way, grants the old session was given since are never counted.) Of those,
      // only what it had when the replacement was logged went on; a grant given after that stayed with it.
      const pool = !outcome.carried || holder.outcome ? moved : grants.filter(domain => Number.isSafeInteger(domain?.createdAt) && domain.createdAt <= next.at &&
        domain.initiators?.some(i => i?.id === holder.id && i.nativeId === holder.nativeId));
      const inForce = pool.filter(domain => !domain.revokedAt && domain.expiresAt > now).length;
      const carried = { oldId: holder.id, at: outcome.at, old: label(holder.id), carried: outcome.carried,
        ...(outcome.carried ? { newId: outcome.to.id, new: label(outcome.to.id), inForce } : { reason: String(outcome.reason || 'refused').slice(0, 60) }) };
      let said = false, wrote = false;
      const say = room => { try { if (roomState.recordCarried(room, carried).recorded) wrote = true; said = true; } catch { /* That space is gone, archived or busy; another may still say it. */ } };
      for (const room of rooms) say(room);
      // None of them could take it, for the second time: the default space, rather than waiting on spaces
      // that may never come back.
      if (!said && checked?.untold && !rooms.has('shared')) say('shared');
      if (wrote) await broadcastRoom();
      // Not said anywhere yet: the holder stays listed and this is tried again.
      if (!said) { grantChecked.set(holder.id, { retryAt: now + GRANT_RETRY_MS, untold: true }); continue; }
      await call({ step: 'told' });
      grantChecked.delete(holder.id);
    } catch {
      // The backend could not answer. Whatever it had decided is in its journal and is picked up again with
      // a later state, no sooner than half a minute from now; nothing polls.
      grantChecked.set(holder.id, { retryAt: now + GRANT_RETRY_MS });
    } finally { grantCarrying.delete(holder.id); }
  }
}
function auditBackgroundOperation(record) {
  const rooms = new Set(record.guard?.auditRooms || ['shared']);
  if (record.approvedBy === 'standing' && record.state === 'complete' && record.command.method === 'spaceCreate' && typeof record.value === 'string') rooms.add(record.value);
  roomState.recordControlOperation(record, [...rooms]);
  // Consent depends on the durable event, never on every window completing a
  // read. A disconnected or slow window cannot hold cancellation or execution.
  broadcastRoom().catch(() => {});
}
function notifyBackgroundConfirmation(record) {
  if (backgroundNotifications && backgroundNotifications.control !== backgroundControl) {
    backgroundNotifications.dispose(); backgroundNotifications = null;
  }
  backgroundNotifications ||= new (require('./confirmation-notifications.cjs').ConfirmationNotifications)({
    Notification, control: backgroundControl, format: displayText, reveal: revealRecord, screen: notificationScreen,
    active: () => primary && !quitting, seen: queueOutcomeSeen,
    snapshot: async row => {
      const context = await backgroundControl.view(row.actor, row.command.view_id); await context.checkActor();
      const state = sessionLabels.apply(roomState.apply(confirmationSnapshot(context.client)));
      const fields = ['id', 'nativeId', 'name', 'provider', 'archived', 'roomId', 'roomIds', 'roomMembershipRevisions', 'memberRevision', 'transportDisconnected', 'backendUnavailable', 'nativeContextPending'];
      const target = state.sessions.find(s => s.id === row.command.arguments[0]);
      const saved = row.command.method === 'restoreSession' && roomState.value.sessionArchives[row.command.arguments[0]];
      const restorable = Boolean(saved && target && saved.nativeId === target.nativeId && require('./room-state.cjs').sameHome(target, saved.detached));
      const restoreGuard = restorable ? JSON.stringify(context.fingerprint(row.command)) : null;
      return { state: { unavailable: state.unavailable, roomStorageWarning: state.roomStorageWarning,
        sessions: state.sessions.map(s => Object.fromEntries(fields.filter(key => Object.hasOwn(s, key)).map(key => [key, s[key]]))),
        rooms: state.rooms.map(r => ({ id: r.id, name: r.name, archived: r.archived })) },
        archives: saved ? { [row.command.arguments[0]]: { nativeId: saved.nativeId, restorable, rooms: saved.rooms.map(r => ({ id: r.id })) } } : {},
        // Keep the fingerprint private; the notice receives only a live equality check.
        ...(restorable ? { restoreCurrent: () => typeof restoreGuard === 'string' && JSON.stringify(context.fingerprint(row.command)) === restoreGuard } : {}) };

    },
  });
  return backgroundNotifications.notify(record);
}

function notifyQueueOutcome(outcome, source) {
  const { roomId, eventId, status, reason, memberId, memberName, task, reply, question } = outcome;
  if (quitting || !eventId || queueOutcomeSeen.has(eventId) || !(status === 'failed' || status === 'waiting' && !reason)) return;
  queueOutcomeSeen.add(eventId);
  if (queueOutcomeSeen.size > 200) queueOutcomeSeen.delete(queueOutcomeSeen.values().next().value);
  let notification;
  try {
    if (!Notification.isSupported()) {
      if (status === 'waiting') showQuestionNotification(null, butlerIngress?.ledger, source);
      return;
    }
    const room = { ...roomState.metadata(roomId), id: roomId };
    const recordedName = room.events?.findLast(e => e.sessionId === memberId && e.uiMessage?.key === 'notice.queue.dispatched')?.uiMessage?.params?.name;
    const name = [memberName, recordedName].find(value => value && value !== memberId) || displayText('identity.historicalMember');
    const space = untouchedDefault(room) ? displayText('space.defaultName') : room.name;
    const prefix = status === 'failed' ? 'os.queueFailed' : 'os.decision';
    notification = new Notification({ title: displayText(prefix + 'Title'),
      body: displayText(prefix + 'Body', { name, space, task, question: question ?? queueRules.decisionLine(reply, task) }) });
    queueOutcomeNotifications.set(eventId, notification);
    if (queueOutcomeNotifications.size > 50) queueOutcomeNotifications.delete(queueOutcomeNotifications.keys().next().value);
    notification.once('close', () => queueOutcomeNotifications.delete(eventId));
    notification.once('click', () => { queueOutcomeNotifications.delete(eventId); revealRecord({ roomId, eventId }); });
    if (status === 'waiting') showQuestionNotification(notification, butlerIngress?.ledger, source);
    else notification.show();
  } catch { queueOutcomeNotifications.delete(eventId); }
}
function revealRecord(target) {
  if (quitting) return;
  pendingReveal = target;
  focusOrOpen();
  flushReveal();
}
function flushReveal() {
  if (quitting) { pendingReveal = null; return; }
  if (!pendingReveal) return;
  const ready = [...windows.values()].filter(c => !c.background && c.uiReady && !c.win.isDestroyed());
  const context = ready.find(c => c.win.isFocused()) || ready[0];
  if (!context) return;
  const target = pendingReveal; pendingReveal = null;
  if (!backgroundTest) { if (context.win.isMinimized()) context.win.restore(); context.win.show(); context.win.focus(); }
  localPages?.workspace(context);
  sendToPage(context, 'workspace:reveal-record', target);
}
function discardReveal(context) {
  if (!context.uiReady) pendingReveal = null;
}
// The designated butler is not joined to a space while it holds the designation (the person revokes it first).
// Leaving is never refused, and a record that cannot be read refuses nothing here: the state warning says so.
function keepStewardOutside(id, join) {
  if (join !== true) return;
  let steward = null;
  try { steward = stewardRole?.current() || null; } catch { return; }
  if (steward && steward.sessionId === id) throw uiError('error.steward.joinSpace');
}
// The duty statement as the butler is given it: when designated, and with the handoff to a session that replaces it.
function stewardDutyText() {
  return displayText('steward.duty.header') + '\n' + (stewardRole.duty ?? displayText('steward.duty.default'));
}
// A session NAW opened to replace another and has not finished moving in (steward step 2, batch 2): its join is still
// to come, and refusing that join would make the rotation stop it. Nor one a failed rotation is still to stop (never
// handed work); a kept one, one that has the work while its old session is in use (waitingOld), or one the failed
// rotation had already handed work to, is the person's to choose.
function midRotation(id) {
  return Object.values(queueDispatcher?.rotations || {}).some(record => record?.newId === id && record.phase !== 'kept' && !queueRules.waitingOld(record) && !(record.phase === 'failed' && record.handoffConfirmed));
}
// The designated butler calling through NAW now (steward step 2, batch 4): the very session and native session the
// designation names, the designation readable, the session usable and in no space. Anything else is not the butler,
// so a refused or unreadable designation falls back to the rules for everyone else. The person's words, 2026-11-12:
// 「这些事难道你不能做吗」; checklist items 4, 5 and 9, taken as recommended.
async function stewardCaller(c) {
  if (!c?.background) return null;
  const actor = backgroundOperation.current();
  let steward = null; try { steward = stewardOf?.() || null; } catch { return null; }
  if (!steward || !actor || steward.sessionId !== actor.id || steward.nativeId !== actor.nativeId) return null;
  const record = roomState.apply(await c.client.call('initial')).sessions.find(s => s.id === actor.id);
  if (!record || record.nativeId !== actor.nativeId || record.archived || record.nativeContextPending || ['ended', 'background'].includes(record.state)) return null;
  try { if (roomIds(record).length) return null; } catch { return null; }
  return { id: record.id, name: sessionLabels.labels.get(record.id) || record.name };
}
function conversationReaderAllowed(actor) {
  // The butler reads as any session may, also when it is the secretary too (checklist item 9 merges the two).
  if (isStewardActor(actor)) return true;
  const secretary = queueSecretary?.current();
  return !secretary || secretary.sessionId !== actor.id || secretary.nativeId !== actor.nativeId;
}
// The designated butler, as the designation names it now (steward step 2, batch 4), for gates that judge a call with
// the state already in hand. A designation that cannot be read is nobody.
function isStewardActor(actor) {
  let steward = null; try { steward = stewardOf?.() || null; } catch { return false; }
  return Boolean(steward && actor && steward.sessionId === actor.id && steward.nativeId === actor.nativeId);
}
// Whether the butler reads another session's conversation without the person confirming each read (the person,
// 2026-11-12 14:24, to 「大管家每读一次别的会话的对话都要你点确认，建议改成不用每次确认，但每读一次都记进『大管家的
// 记录』」: 「按你推荐的来」). Only the designated butler, usable and in no space, and only while its record takes lines:
// each read is first a step there, with whom it read and how far (stewardRecord view). It covers the conversation and
// its images (`initial`, `previewImage` of a session); terminal reads and every other maintenance action still ask.
function stewardReadsUnasked(actor, snapshot) {
  if (!isStewardActor(actor) || !stewardRecord || stewardRecord.failed || !stewardRecord.recording(actor)) return false;
  let record = null; try { record = roomState.apply(snapshot).sessions.find(s => s.id === actor.id && s.nativeId === actor.nativeId); } catch { return false; }
  if (!record || record.archived || record.nativeContextPending || ['ended', 'background'].includes(record.state)) return false;
  try { return roomIds(record).length === 0; } catch { return false; }
}
function conversationAccess(actor, snapshot) {
  const access = { roomIds: [], secretary: true };
  try { access.secretary = !conversationReaderAllowed(actor); } catch { /* Unknown roles get metadata only. */ }
  const current = snapshot?.sessions?.find(s => s.id === actor.id && s.nativeId === actor.nativeId);
  if (current && !current.archived && !current.nativeContextPending && !roomState.value.archivedSessions?.includes(actor.id)) {
    try { access.roomIds = roomIds(current); } catch { /* Invalid membership grants nothing. */ }
    // The butler sees every space as a member does (the person, 2026-11-11: 「大管家权限最高,应该啥都可以看到和操作」,
    // 「都能看,」; checklist 2026-11-12). Only while it is in no space, as its designation requires; what it reads through
    // NAW is a step in its record.
    let outside = false; try { outside = roomIds(current).length === 0; } catch { outside = false; }
    if (outside && isStewardActor(actor)) {
      // The backend's rooms and the desktop's own list of spaces (a space nobody has joined yet has no backend room).
      access.roomIds = [...new Set([snapshot?.room?.id, ...(snapshot?.rooms || []).map(room => room?.id), 'shared', ...(roomState?.spaces?.rooms || []).map(room => room?.id)].filter(id => typeof id === 'string' && id))];
      access.secretary = false;
    }
  }
  return access;
}
// A background window's own state that is not in its saved view (see context.retain).
const RETAINED_CONTEXT = ['clipboardText', 'clipboardImage', 'clipboardRevision', 'filePreview', 'worktreeSource', 'worktreePlan',
  'worktreePreviewRevision', 'recordsFolder', 'recordsExported'];
function controlRequestActors(client) {
  return roomState.apply(client.snapshot()).sessions.map(s => ({ id: s.id, nativeId: s.nativeId,
    archived: s.archived, nativeContextPending: s.nativeContextPending }));
}
function projectBackgroundRecord(record, context = null) {
  if (['terminalSnapshot', 'observe', 'terminal'].includes(record.command.method) && record.readAuthorization && record.value !== undefined) {
    try { if (conversationReaderAllowed(record.actor)) return record; } catch { /* Fail closed on an unknown role. */ }
    const { value: _privateValue, ...publicRecord } = record; return publicRecord;
  }
  if (!['initial', 'previewImage', 'spaceFiles'].includes(record.command.method) || record.value === undefined) return record;
  const target = backgroundOperation.conversationTarget(record.command.method, record.command.arguments, record.actor);
  // Approved by the person, or read without asking by the butler (stewardReadsUnasked) while it still is the butler.
  const allowed = record.humanDecision === 1 || record.unasked === true && isStewardActor(record.actor);
  const candidate = allowed && record.readAuthorization?.sessionId === target ? record.readAuthorization : null;
  let read = null;
  if (candidate) try { if (conversationReaderAllowed(record.actor)) read = candidate; } catch { /* Fail closed on an unknown role. */ }
  if (record.command.method === 'previewImage' && target && (!read || read.sessionId !== target)) {
    const { value: _privateValue, ...publicRecord } = record; return publicRecord;
  }
  const access = conversationAccess(record.actor, context?.client.snapshot?.());
  if (record.command.method === 'spaceFiles' && record.command.arguments[1] !== undefined &&
      (record.readAuthorization?.roomId !== record.command.arguments[0] || access.secretary || !access.roomIds.includes(record.command.arguments[0]))) {
    const { value: _privateValue, ...publicRecord } = record; return publicRecord;
  }
  const source = record.command.arguments[0];
  if (record.command.method === 'previewImage' && ['room', 'space-message'].includes(source?.kind) &&
      (access.secretary || !access.roomIds.includes(source.roomId || 'shared'))) {
    const { value: _privateValue, ...publicRecord } = record; return publicRecord;
  }
  if (record.command.method !== 'initial') return record;
  return { ...record, value: backgroundOperation.conversationSnapshot(record.value, record.actor, read, record.value?.viewState?.selected, access) };
}
async function assertSpaceFileReader(context, roomId) {
  if (!context.background) return;
  await context.refresh?.();
  const access = conversationAccess(context.actor, context.client.snapshot());
  if (access.secretary || !access.roomIds.includes(roomId)) throw uiError('error.background.spaceFileMembership');
}
// A background window owns an agent's connection and dialogs but never loads a document. Nothing can
// receive what is sent to it, and the browser keeps every such message in memory for as long as the window
// lives. With one such window per agent that had used workspace control, and every state change, terminal
// chunk and progress line sent to each, that memory, which no process accounts for, grew until the machine
// ran out (2026-11-10). Everything sent to a window's page goes through here or through pushState.
// The bell works its reminders out again when a block of the operations record is sealed or added, not by polling.
function recordsChanged(force = false) {
  mobileBroker?.refreshPush();
  let count = -1; try { count = backgroundControl?.archive?.manifest.blocks.length ?? -1; } catch { /* Read again next time. */ }
  if (!force && count === operationsBlocks && backgroundControl) return;
  operationsBlocks = count;
  for (const c of windows.values()) sendToPage(c, 'workspace:records-changed');
}
function stewardWakeChanged() {
  const status = stewardWake?.view({ early: true }).blocked || null;
  for (const context of windows.values()) sendToPage(context, 'workspace:steward-wake', status);
  recordsChanged(true);
}
function sendToPage(context, channel, ...data) {
  if (context.background || context.win.isDestroyed()) {
    return;
  }
  context.win.webContents.send(channel, ...data);
}
// Every 'workspace:state' send goes through here. Once a window's page has reported that it is ready, one
// full snapshot is in transit at a time and the newest wins (state-push.cjs); until then, and for a window
// whose page never reports ready (a background window loads no document), the snapshot is sent as before
// with sequence 0, which needs no reply. Snapshots to a ready page are also spaced by STATE_PUSH_WAIT, so
// changes in quick succession are one redraw; a single change still goes at once (UI lag, 2026-11-12).
const STATE_PUSH_WAIT = 250;
// While the person types in a window, its snapshot waits for a pause this long, and goes at most this long
// after the previous one (state-push.cjs).
const STATE_PUSH_TYPING_QUIET = 400;
const STATE_PUSH_TYPING_HOLD = 1500;
function pushState(context, display) {
  if (context.background || context.win.isDestroyed()) {
    return;
  }
  if (context.statePush) {
    // Made again if it has to wait: it then includes what was sent to the page meanwhile (a new session name).
    context.statePush.push(display, () => displayState(context.client.snapshot(), context, null, true));
    return;
  }
  context.win.webContents.send('workspace:state', omitHidden(display, context.shown), 0);
}
// The page's ready report arms the bound; a reload or the end of its process removes it, because the
// acknowledgement for a snapshot sent to the old document can no longer arrive.
function bindStatePush(context) {
  context.armStatePush = () => {
    // A second ready report from the same document keeps the bound and its numbering.
    if (context.statePush) {
      return;
    }
    context.statePush = createStatePush((value, sequence) => {
      if (!context.win.isDestroyed()) {
        // Left out at sending, not when made: a snapshot that waited still gets the messages of a session
        // the page started showing meanwhile (shown-sessions.cjs).
        context.win.webContents.send('workspace:state', omitHidden(value, context.shown), sequence);
      }
    }, { wait: STATE_PUSH_WAIT, quiet: STATE_PUSH_TYPING_QUIET, maxHold: STATE_PUSH_TYPING_HOLD });
  };
  // A new document has none of the messages: it gets every one until it reports what it shows.
  context.win.webContents.on('did-start-loading', () => {
    context.statePush?.close();
    context.statePush = null;
    context.shown = null;
  });
  context.win.webContents.on('render-process-gone', () => {
    context.statePush?.close();
    context.statePush = null;
    context.shown = null;
  });
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
    else if (humanSessionWork(method, args)) queueDispatcher?.noteHuman(args[0], method, args[1]);
    if (['send', 'queue', 'queueShared', 'steerShared', 'steer', 'forward', 'run', 'input', 'claim', 'terminal', 'approve', 'answer', 'draft', 'resume'].includes(method)) {
      for (const id of (method === 'run' && Array.isArray(args[0]) ? args[0] : [args[0]])) roomState.assertAvailable(id, ['forward', 'queueShared', 'steerShared', 'run'].includes(method), roomId);
    }
  };
  const send = (channel, ...data) => { if (context.client === client) sendToPage(context, channel, ...data); };
  client.on('state', data => { if (context.client === client && !win.isDestroyed() && !context.background) {
    observePersonActions(data);
    const display = displayState(data, context, null, true);
    pushState(context, display); notifyToolWait(data, win); notifyCapacity(display, win);
  } });
  // B6 E4: what the backend marks as stuck, and a native version NAW has not verified, are recorded in the session's spaces. Records only.
  client.on('state', data => {
    // Each writer on its own: one that cannot write neither stops the other nor holds state.
    try { butlerIngress?.observeTerminalDialogs(data?.sessions); } catch { /* Retried on the next state. */ }
    try { butlerIngress?.observeNativeQuestions(data?.sessions); } catch { /* Retried on the next state. */ }
    try { butlerIngress?.observeRecoveryFailures(data?.sessions); } catch { /* Retried on the next state. */ }
    try { butlerIngress?.observeUnbound(data?.sessions); } catch { /* Retried on the next state. */ }
    try { butlerIngress?.observeControlRefusals(data?.sessions, { steward: () => stewardRole?.current() }); } catch { /* Retried on the next state. */ }
    try { butlerIngress?.observeWakeUndelivered(data?.sessions, { steward: () => stewardRole?.current(), formerly: id => queueDispatcher?.continuedFrom(id) || [],
      wasButler: (id, nativeId, at, chain) => stewardRecord?.heldRole(id, nativeId, at, chain) }); }
    catch { /* Retried on the next state. */ }
    try { butlerIngress?.observeHumanInputs(data?.sessions, { steward: () => stewardRole?.current(), name: s => sessionLabels.labels.get(s.id) || s.name }); }
    catch { /* Retried on the next state; no native input is replayed. */ }
    const name = s => sessionLabels.labels.get(s.id) || s.name, wrote = ['recordStuck', 'recordVersionGates'].map(writer => { try { return roomState[writer](data?.sessions, name); } catch { return false; } });
    if (wrote.some(Boolean)) broadcastRoom().catch(() => {});
    if (!context.background) placeOpened(client, data).catch(() => {});
    if (!context.background) carryGrants(client, data).catch(() => {});
  });
  client.on('terminal', data => send('workspace:terminal', data));
  client.on('progress', data => send('workspace:progress', data));
  client.on('closed', () => { if (context.client === client) reconnectClosed(context, client).catch(() => { if (context.client === client) noticeDisconnected(context); }); });
}
function displayState(snapshot, context, read = null, toPage = false) {
  // toPage: goes to the page through omitHidden or reportShown, which make the rows left out here as they are needed.
  if (context?.client) snapshot = confirmationSnapshot(context.client, snapshot);
  const roomId = context?.view?.spaceId || 'shared';
  const display = roomState.apply(sessionLabels.apply(submissionState(snapshot)), roomId);
  display.sessions = display.sessions.map(s => ({ ...s }));
  const operatorCreations = context?.background ? [] : display.sessions.filter(s => !s.archived).flatMap(s =>
    (s.messages || []).filter(m => m.kind === 'operator-open' && m.operator?.creation === 'pending-authorization' && m.operator.actionable !== false && m.operator.initiatorId === s.id)
      .map(message => ({ sessionId: s.id, nativeId: s.nativeId, message })));
  const backgroundConfirmations = context?.background ? [] : backgroundControl?.confirmations(display, snapshot) || [];
  if (!context?.background && context?.win) {
    const key = backgroundConfirmations.map(confirmationInbox.summaryText).join('\n');
    if (key !== confirmationProjectionKeys.get(context.win)) { confirmationProjectionKeys.set(context.win, key); recordsChanged(true); }
  }
  const control = backgroundControl, withRecords = s => {
    const rows = control.rows(s.id, context?.background ? null : display, { expire: context?.background === true });
    return rows.length ? [...s.messages, ...rows].sort((a, b) => a.time - b.time) : s.messages;
  };
  let times = null;
  const timesOf = id => (times ||= control.recordTimes()).get(id);
  if (control) for (const s of display.sessions) {
    if (toPage && !context.background) leaveRecords(s, { times: () => timesOf(s.id), messages: () => withRecords(s) });
    else s.messages = withRecords(s);
    if (context?.background) {
      s.liveDraft = ''; s.draft = '';
    }
  }
  const outboxWarning = backgroundUnavailable ? 'Background control is unavailable; existing native sessions and ordinary controls remain available.' : outboxQuitFailed ? 'Outbox cleanup could not be confirmed. Quit again to close the app; native sessions keep running.'
    : outboxUnavailable ? 'The independent space outbox is unavailable; new delivery cannot be confirmed.' : '';
  let secretary = null, secretaryWarning = '';
  try { secretary = queueSecretary?.current() || null; } catch { secretaryWarning = displayText('error.queue.secretaryState'); }
  let integrator = null, integratorWarning = '';
  try { integrator = integratorRole?.current() || null; } catch { integratorWarning = displayText('error.integrator.state'); }
  // The session the person talks to as the butler. A record that cannot be read is a warning, never "nobody".
  let steward = null, stewardDuty = null, stewardWarning = '';
  try { stewardDuty = stewardRole?.duty ?? null; steward = stewardRole?.current() || null; } catch { stewardWarning = displayText('error.steward.state'); }
  const warning = [outboxWarning, secretaryWarning, integratorWarning, stewardWarning].filter(Boolean).join('\n');
  // The page asks about handoffs only where they are enabled (or could not start): elsewhere the state is as it always was.
  const handoffEnabled = queueDispatcher?.integration || queueDispatcher?.integrationError ? { handoffEnabled: true } : {};
  const result = { ...display, queueSecretary: secretary, integrator, ...handoffEnabled, steward, ...(context?.background ? {} : { stewardDuty, vendorIcons: localVendorIcons() }), ...(context?.background ? {} : { operatorCreations, backgroundConfirmations, backgroundConfirmationsAvailable: Boolean(backgroundControl && !backgroundControl.failed && !backgroundUnavailable) }), ...(warning ? { storageWarning: [display.storageWarning, warning].filter(Boolean).join('\n'), storageWarningUiMessage: null } : {}), sessions: display.sessions.map(s => ({ ...s, peerIdentity: roomPeerIdentity(s, roomId), sharedActivity: s.sharedActivities?.[roomId] || (roomId === 'shared' ? s.sharedActivity : null) })), viewStorageWarning, viewStorageWarningUiMessage,
    ...(context?.background ? {} : { stewardWakeStatus: stewardWake?.view({ early: true }).blocked || null }),
    switchEnded: endedByMove(display.sessions), rotationChains: queueDispatcher ? queueDispatcher.rotationChains() : [],
    ...(context?.background ? {} : { modelChanges: sessionModelChanges?.view() || [] }),
    butler: butlerIngress?.status() || { intake: 'blocked', errorCode: 'source-unavailable', activation: 'off', recordPeriod: 'off' } };
  return context?.background ? backgroundOperation.conversationSnapshot(result, context.actor, read, context.view.selected, conversationAccess(context.actor, snapshot)) : result;
}
function reportViewStorage(warning, uiMessage = null) {
  if (viewStorageWarning === warning) return;
  viewStorageWarning = warning; viewStorageWarningUiMessage = uiMessage;
  for (const context of windows.values()) sendToPage(context, 'workspace:view-storage', warning, uiMessage);
}
// Space task queues: NAW sends each idle member its next item (queue-dispatch.cjs).
let queueDispatcher = null;
// The integration handoff record of this run when its switch is open (B6); null in the daily app.
let integrationHandoffs = null;
// The person's choice of main repository for integration handoffs, as the entry uses it; set with the engine.
let integrationRepository = null;
// The last fault of that record met while the person acted on it, kept so that it is not lost: { message, at }.
let integrationFault = null;
const HUMAN_SESSION_METHODS = new Set(['prepareInput', 'input', 'draft', 'send', 'queue', 'steer', 'claim', 'terminal', 'interrupt', 'approve', 'answer', 'forward', 'queueShared', 'steerShared']);
// A terminal's own replies (focus, cursor reports) are not the person typing.
function terminalReplyOnly(method, args) {
  return method === 'input' && queueRules.terminalReplyOnly(args[1]);
}
// Nor is a window taking a session no open window holds as it shows it (renderer takeFreeSession): showing
// a space's members must not hold their queued work back.
function humanSessionWork(method, args) {
  return HUMAN_SESSION_METHODS.has(method) && typeof args[0] === 'string' && !terminalReplyOnly(method, args) && !(method === 'claim' && args[2] === 'free');
}
// A key the person typed in a window's page: the composer's draft, the terminal (not its own replies), or a
// space composer's text, which comes with every viewState. State for that page then waits for a pause.
function typingKey(name, view, args) {
  if (name === 'draft') return true;
  if (name === 'input') return !terminalReplyOnly(name, args);
  const next = args[0];
  if (name !== 'viewState' || !next || typeof next !== 'object') return false;
  if (!next.roomViews || typeof next.roomViews !== 'object') return typeof next.sharedDraft === 'string' && next.sharedDraft !== (view?.sharedDraft ?? '');
  return Object.entries(next.roomViews).some(([id, room]) => typeof room?.sharedDraft === 'string' && room.sharedDraft !== (view?.roomViews?.[id]?.sharedDraft ?? ''));
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
      clients: personClient,
      // A connection of its own is no page a person sees: what it creates is the person's window's to use.
      connect: owner => connect(dataDir, owner, { page: false }),
      labels: sessionLabels.labels,
      broadcast: broadcastRoom,
      notify: notifyRotation,
      // The butler stays in no space: the dispatcher rotates it by this name and hands its duty statement on
      // (steward step 2, batch 3). The record then follows the logged rotation (steward-role.cjs current()).
      steward: () => {
        // Read again only when the designation or rotation log files change: this runs on every planning pass.
        const current = stewardOf?.() || null;
        return current && { ...current, duty: stewardDutyText() };
      },
      creationDefaults: snapshot => creationDefaults.get(snapshot?.sessions || []),
      modelChanges: () => sessionModelChanges?.ids() || [],
      directoryTrustTimeoutMs: process.env.NAW_QUEUE_DIRECTORY_TRUST_TIMEOUT_MS,
      // Passive local facts only; no controller or native/model runner is bound.
      observeQueueState: states => butlerIngress?.observeQueues(states),
      observePersonActions,
      // The butler, woken on what NAW records when the person or the butler turned that on (steward-wake.cjs).
      stewardWake: stewardWake || undefined,
      // The agent that asked, told what the person answered on its confirmation cards (answer-notices.cjs).
      answerNotices,
      // What this start brought, owed to the queue secretary (version-events.cjs).
      versionNotices,
      // Sessions on a backend in a migration's quiet window get no new item or NAW message (quiet-windows.cjs).
      quietWindows: quietWindows || undefined,
      // A member whose own conversation was compacted COMPACT_LIMIT times continues in a new session.
      countCompactions: true,
      // Not yet built: it throws, and the dispatcher tries again on its next pass.
      rotationStalled: stall => butlerIngress.rotationStalled(stall),
      errorStalled: stall => butlerIngress.errorStalled(stall),
    };
    if (backgroundTest && process.env.NAW_TEST_QUEUE_DIRECTORY_MIGRATION === '1') options.migrateDirectories = true;
    // B6 integration handoffs are closed in the daily app: only a verified isolated test run can
    // open them, until the person's own actions for a held or waiting handoff exist. Closed,
    // nothing is built and the dispatcher runs exactly as before.
    if (backgroundTest && process.env.NAW_TEST_INTEGRATION_HANDOFF === '1') {
      options.integration = dispatcher => integrationEngine(dispatcher);
      options.integrationUnreadable = () => notifyHandoff(null);
      options.integrationFailed = () => notifyHandoff(undefined);
    }
    // Only a verified isolated test run may lower the record limit, the memory limit
    // (and the age a session needs before a memory rotation) or the quiet time after the person's input.
    const testContent = Number(process.env.NAW_TEST_QUEUE_CONTENT_LIMIT);
    if (backgroundTest && Number.isSafeInteger(testContent) && testContent > 0) {
      options.contentLimits = { claude: testContent, codex: testContent };
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
    const testCompact = Number(process.env.NAW_TEST_QUEUE_COMPACT_LIMIT);
    if (backgroundTest && Number.isSafeInteger(testCompact) && testCompact > 0) {
      options.compactLimit = testCompact;
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
function personClient() {
  for (const context of windows.values()) {
    const usable = !context.background && !context.win.isDestroyed() && !context.client.closing && !context.client.socket.destroyed;
    if (usable) {
      return context.client;
    }
  }
  return null;
}
// The person's model changes, also those still waiting for a session to be idle (N5, model-change.cjs).
let sessionModelChanges = null;
function modelChanges() {
  return sessionModelChanges ||= new (require('./model-change.cjs').ModelChanges)({
    dataDir,
    client: personClient,
    apply: snapshot => roomState.apply(snapshot),
    rotations: () => queueDispatcher?.rotations || {},
    engaged: () => queueDispatcher?.integration?.holding() || [],
    humanAt: () => queueDispatcher?.humanAt || new Map(),
    saveTerminal: async id => {
      const file = await queueRules.saveTerminalScreen(owner => connect(dataDir, owner, { page: false }), 'naw-model', path.join(dataDir, 'rotation-terminals'), id, Date.now());
      return file && path.join(dataDir, file);
    },
    changed: () => { broadcastRoom().catch(() => {}); queueDispatcher?.schedule(); },
    done: notifyModelChange,
  });
}
function notifyModelChange(notice) {
  for (const context of windows.values()) sendToPage(context, 'workspace:model-changed', notice);
}
async function broadcastRoom() {
  await Promise.allSettled([...windows.values()].map(async context => {
    // A background window has no page: do not fetch and build a state that would be dropped.
    if (context.background || context.win.isDestroyed() || context.client.socket.destroyed) return;
    const snapshot = await context.client.call('initial');
    pushState(context, displayState(snapshot, context, null, true));
  }));
}
function broadcastName(id, name) {
  for (const context of windows.values()) sendToPage(context, 'workspace:session-name', { id, name });
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
  const context = { win, client, view, failed: false, uiReady: false };
  windows.set(win.webContents.id, context); bindClient(context); bindStatePush(context);
  const ready = new Promise((resolve, reject) => { context.ready = resolve; context.readyTimer = setTimeout(() => reject(new Error('UI did not become ready')), 25000); });
  ready.catch(() => {}); // loadURL may fail before the readiness timer fires.
  win.webContents.on('did-start-loading', () => { context.uiReady = false; });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('page-title-updated', event => { event.preventDefault(); if (!win.isDestroyed()) win.setTitle('Native Agent Workspace'); });
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
    discardReveal(context);
    closeAppMobileSetup(context);
    // A renderer/webContents shutdown can bypass the cancellable close event.
    if (!quitting && !context.failed && view.active !== false) {
      view.active = false;
      try { saveViews(); } catch { view.active = true; }
    }
    windows.delete(id); context.statePush?.close(); context.imagePreviews?.close(); context.client.close({ leave: !quitting && !context.failed });
    localPages?.closeOwner(context);
  });
  try { await win.loadURL(entry); await ready; }
  catch (error) { discardReveal(context); if (quitting || win.isDestroyed()) return; throw new Error(startupMessage(error, displayLanguage())); }
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
function connectionUpdateOptions(client, applicationVersion, profile = roomState) {
  const alpha = value => typeof value === 'string' && value.match(/^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-alpha\.(0|[1-9]\d*)$/);
  const current = alpha(applicationVersion), seen = new Set(), options = [];
  const visibleIds = new Set(profile.apply(client.snapshot()).sessions.filter(record => !record.archived).map(record => record.id));
  for (const entry of client.entries) {
    if (seen.has(entry.key)) continue; seen.add(entry.key);
    const visible = entry.state.sessions.filter(record => visibleIds.has(record.id));
    if (!visible.length || entry.state.runtimeVersion === applicationVersion) continue;
    const record = visible.find(value => value.nativeId) || visible[0], version = entry.state.runtimeVersion, reported = alpha(version);
    const old = reported && current && reported[1] === current[1] && Number.isSafeInteger(Number(reported[2])) && Number.isSafeInteger(Number(current[2])) && Number(reported[2]) < Number(current[2]);
    const status = continuationStatus(entry.state, record.id);
    const unavailable = entry.closed || entry.closing || client.closing || client.control?.maintenance.has(entry.key);
    const effectiveActive = entry.state.sessions.some(value => (client.sessionState?.(value) || value.state) !== 'ended');
    // Moving idle sessions too (T-122): automatic only where the runtime proves nothing would be lost.
    const plan = old && !unavailable && entry !== client.active ? backendSwitch.backendPlan(entry.state, value => client.sessionState?.(value) || value.state, runningRelays(client)) : null;
    // A plan that stops nothing (its sessions only carried, such as recoverable ones whose process is gone) still
    // moves (alpha.290: such a backend was told as not movable for good). A refused one keeps the menu's own
    // guidance; its reason goes only to the version line (moveRefused).
    options.push({ backendKey: entry.key, id: record.id, nativeId: record.nativeId || null, version: version || null,
      switch: plan && (plan.stops.length || plan.blocked || plan.ready) ? { ready: plan.ready, auto: plan.auto, blocked: Boolean(plan.blocked), reason: plan.reason, reasonUiMessage: plan.reasonUiMessage || null, stops: plan.stops, endsCodex: Boolean(plan.endsCodex) } : null,
      moveRefused: plan && !plan.ready && !plan.blocked ? plan.reason || null : null,
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
function isCurrentHumanContext(context) {
  try { return Boolean(context && !context.background && !context.win.isDestroyed() &&
    windows.get(context.win.webContents.id) === context); }
  catch { return false; }
}
function showDialog(c, kind, options) {
  const method = { message: 'showMessageBox', open: 'showOpenDialog', save: 'showSaveDialog' }[kind];
  return background.dialog(c, kind, options, (win, value) => dialog[method](win, value));
}
function roomArchiveDetail(state, room = 'shared') {
  const plan = roomState.roomArchivePlan(state, room);
  const names = ids => ids.map(id => {
    const session = state.sessions.find(s => s.id === id);
    return `${backgroundOperation.visibleText(sessionLabels.labels.get(id) || session?.name || id)} (${id})`;
  }).join(', ') || '—';
  return displayText('archive.roomConfirmation', { archive: names(plan.archive), keep: names(plan.keep) });
}
async function archiveRoomConfirmed(c, room = 'shared') {
  const snapshot = await c.client.call('initial'), approved = roomState.roomArchivePlan(snapshot, room);
  if (c.background) {
    const request = backgroundOperation.request();
    if (!request?.maintenanceApproved || JSON.stringify(request.guard?.archivePlan) !== JSON.stringify(approved)) throw uiError('error.room.sessionRestoreChanged');
  } else {
    const answer = await showDialog(c, 'message', { type: 'warning', message: displayText('background.action.archiveRoom'),
      detail: roomArchiveDetail(snapshot, room), buttons: [displayText('common.cancel'), displayText('background.confirm')], defaultId: 0, cancelId: 0 });
    if (answer.response !== 1) return false;
  }
  await roomState.archiveRoom(c.client, sessionLabels.labels, room, approved);
  return true;
}
function register(name, handler) {
  applicationHandlers.set(name, async (c, ...args) => {
    if (c.background) {
      const request = backgroundOperation.request();
      if (!request || request.context !== c) throw Error('Background command has no originating operation');
      await request.valid();
      // B5: which space a grant sends new sessions to is chosen only by the person in the desktop, and saving
      // where a session went is the desktop's own step. An agent can do neither, with or without confirmation.
      if (name === 'operatorAction' && (['placement', 'placed'].includes(args[1]) || args[1] === 'grant' && args[2] && typeof args[2] === 'object' && Object.hasOwn(args[2], 'space'))) throw uiError('error.operator.personOnlySpace');
      if (name === 'operatorAction' && args[1] === 'succession') throw uiError('error.operator.desktopOnly');
      if (name === 'operatorAction' && args[1] === 'quota') throw uiError('error.operator.personOnlyQuota');
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
        if ((s?.approval || s?.nativeApproval || s?.nativeInputRequired) && !backgroundOperation.request()?.maintenanceApproved) {
          const answer = await showDialog(c, 'message', { type: 'warning', message: name, detail: JSON.stringify(args), buttons: [displayText('common.cancel'), displayText('background.confirm')], cancelId: 0 });
          if (answer.response !== 1) return { cancelled: true };
        }
      }
      // Never silently fall back to an old backend that cannot retain actor
      // attribution or preserve the person's draft for these input paths.
      const local = new Set(['interfaceSettings', 'initial', 'uiReady', 'viewState', 'readingState', 'draft', 'retainDraftRecovery', 'discardDraftRecovery', 'rename', 'sidebar', 'roomRename', 'roomNotes', 'roomMemberOrder', 'spaceCreate', 'spaceFiles', 'openLocalFile', 'openLocalPage', 'closeLocalFile', 'saveLocalFile', 'chooseFolder', 'copy', 'landing', 'pasteText', 'copyImage', 'previewImage', 'expandImage', 'releaseImage', 'newWindow', 'openExternal', 'openMessageFile', 'dataDirectory', 'preflight', 'runtimeLocation', 'connectionUpdates', 'retrySave', 'archiveSession', 'restoreSession', 'archiveRoom', 'restoreRoom', 'stewardEvents', 'stewardStanding', 'stewardWake', 'stewardPatrol', 'backgroundWithdraw']);
      // Queue metadata lives in this desktop profile, not a retained backend.
      // Its first argument is task text, never a target native session. The
      // handler below still authenticates the secretary and person-only actions.
      const localQueue = name === 'queueSecretary' || name === 'integrator' || name === 'handoff' || name === 'steward' || name === 'spaceAction' && ['queueAdd', 'queueCancel', 'queueResolve', 'queueClaim', 'releaseRotation'].includes(args[1]);
      if (!local.has(name) && !localQueue) {
        const targetIds = (name === 'spaceAction' ? [args[2]?.[0]].flat() : [args[0]].flat()).filter(id => typeof id === 'string');
        const targets = c.client.entries.filter(e => !targetIds.length || e.state.sessions.some(s => targetIds.includes(s.id)));
        for (const entry of targets.length ? targets : c.client.entries) if (!entry.state.capabilities?.includes(backgroundOperation.CAPABILITY)) throw Error('This backend must adopt background-control support before this operation');
      }
    }
    return handler(c, ...args);
  });
  // Sent many times a second while the person types, scrolls or resizes: these do not hurry the next state.
  // viewState goes with every keystroke in a space's composer; it changes the window's view, never the state.
  // shownSessions and search change no state either: what the page needs is in their reply.
  const hurries = !['input', 'resize', 'readingState', 'draft', 'viewState', 'shownSessions', 'search', 'textPath'].includes(name);
  ipcMain.handle(`workspace:${name}`, async (event, ...args) => {
    const context = windows.get(event.sender.id);
    if (!context || event.senderFrame !== event.sender.mainFrame || !trusted(event.senderFrame.url)) throw new Error('Unexpected IPC source');
    // Read before the handler records the new view. A window without a bound has nothing to hold.
    const person = ['operatorAction', 'spaceAction', 'approve', 'answer'].includes(name) && isCurrentHumanContext(context);
    if (context.statePush && typingKey(name, context.view, args)) context.statePush.typed();
    try {
      const value = await handler(context, ...args);
      if (person) recordPersonAction(name, args, value);
      return { ok: true, value };
    }
    catch (error) { return { ok: false, error: error.message || '操作未完成。', uiMessage: error.message ? uiLocale.displayMessage(error.uiMessage) : uiError('error.main.operationIncomplete').uiMessage }; }
    // The page reads what its action changed once this reply arrives: the state waiting for its time goes first.
    finally { if (hurries) try { context.statePush?.flushNow(); } catch { /* lost, as any failed send */ } }
  });
}
async function replaceBackendSockets(key) {
  // Replace only the updated backend's sockets. Other live transports and every
  // renderer DOM/IME stay intact; reopening a window is unnecessary.
  const replacements = [];
  try {
    for (const context of windows.values()) if (!context.win.isDestroyed()) {
      const client = await connectService(path.join(dataDir, key), context.view.owner, { page: !context.background });
      const replacement = { context, client }; replacements.push(replacement);
      replacement.state = await client.call('initial');
    }
  } catch (error) { for (const replacement of replacements) replacement.client.close(); throw error; }
  for (const { context, client, state } of replacements) {
    context.client.replaceService(key, client, state);
    if (!context.client.socket.destroyed && !context.win.isDestroyed() && !context.background) {
      const refreshed = displayState(await context.client.refresh(), context, null, true);
      // This complete state is newer than any snapshot still waiting behind the bound.
      context.statePush?.discardWaiting();
      sendToPage(context, 'workspace:reconnected', omitHidden(refreshed, context.shown));
    }
  }
}
let connectionEvents = null, reconnector = null;
function noticeDisconnected(context) { const notice = uiError('error.warning.serviceDisconnected'); sendToPage(context, 'workspace:disconnected', notice.message, notice.uiMessage); }
// A transport that closed is connected again without the person; the page hears of it only when that takes long
// or fails, and its button still reconnects everything. Sessions of a restored backend redraw their terminals:
// output sent while the transport was closed never reached this window.
function reconnectClosed(context, client) {
  reconnector ||= createReconnector({
    connect: async (target, key) => {
      const service = await connectService(path.join(dataDir, key), target.view.owner, { page: !target.background });
      try { return { client: service, state: await service.call('initial') }; }
      catch (error) { service.close(); throw error; }
    },
    restored: (target, restored, keys) => {
      if (target.background || target.win.isDestroyed()) return;
      const display = displayState(restored.snapshot(), target, null, true);
      target.statePush?.discardWaiting();
      const sessions = restored.entries.filter(e => keys.includes(e.key)).flatMap(e => e.state.sessions.map(s => s.id));
      sendToPage(target, 'workspace:reconnected', omitHidden(display, target.shown), sessions);
    },
    lost: noticeDisconnected,
    record: event => { connectionEvents ||= createEventLog(path.join(dataDir, 'connection-events.json')); connectionEvents.add(event); },
  });
  return reconnector(context, client);
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
// extra.beforeStops runs once the backend is under maintenance (no NAW input reaches it), before any
// stop; extra.guard re-checks each session on fresh state right before its stop.
async function runBackendSwitch(c, option, requireAuto = false, extra = {}) {
  if (backendSwitching) throw uiError("error.backendUpdateBusy");
  backendSwitching = option.backendKey;
  let finishMaintenance;
  try {
    finishMaintenance = c.client.maintainService(option.backendKey);
    if (extra.beforeStops) {
      await extra.beforeStops();
    }
    const result = await backendSwitch.switchBackend({ dataDir, key: option.backendKey, executablePath: process.execPath, expected: option.switch, requireAuto,
      ensure: ensureService, owner: c.view.owner, sessionState: value => c.client.sessionState?.(value) || value.state, running: () => runningRelays(c.client), guard: extra.guard || null,
      pageOwners: () => new Set([...windows.values()].filter(w => !w.win.isDestroyed() && !w.background).map(w => w.view.owner)) });
    // The move itself is done; a window that cannot reconnect is a separate problem.
    try { await replaceBackendSockets(option.backendKey); } catch { result.reconnectFailed = true; }
    return result;
  } finally { finishMaintenance?.(); backendSwitching = null; switchRecords = backendSwitch.readRecords(dataDir); broadcastRoom().catch(() => {}); }
}
// Both an explicit confirmation and automatic all-ended continuation keep the
// original identity/transport checkpoint through the final refreshed check.
async function runConnectionContinuation(c, id, checkpoint) {
  if (backendSwitching) throw uiError('error.backendUpdateBusy');
  const { target, guard, nativeId, version, expected } = checkpoint;
  const matches = value => value && value.backendKey === target.key && value.nativeId === nativeId && value.version === version;
  backendSwitching = target.key;
  try {
    guard(); await c.client.refresh(); guard();
    const current = c.client.route(id), record = current.state.sessions.find(value => value.id === id), fresh = continuationStatus(current.state, id);
    if (current !== target || current.state.runtimeVersion !== version || record?.nativeId !== nativeId || !fresh.ready ||
        expected !== undefined && !connectionUpdateOptions(c.client, app.getVersion(), roomState).some(option => option.id === id && option.ready && matches(option))) throw uiError('error.main.backendChangedDuringCheck');
    const finishMaintenance = c.client.maintainService(target.key);
    try {
      const { key } = await continueService(dataDir, process.execPath, id);
      try { await replaceBackendSockets(key); }
      catch (error) { error.continuationReconnectFailed = true; throw error; }
      return true;
    } finally { finishMaintenance(); }
  } finally { backendSwitching = null; broadcastRoom().catch(() => {}); }
}
// Automatic moves run one backend at a time: plans the runtime proved, with automatic updates on;
// with migration on (the person's standing confirmation), also plans that need that confirmation
// once their sessions are quiet. Those first keep what each typed-into native terminal shows.
let autoSwitchRunning = false;
async function autoBackendSwitch() {
  if (autoSwitchRunning) return;
  autoSwitchRunning = true;
  try {
    try { observeVersion(); } catch { /* Looked at again next minute. */ }
    await autoBackendSwitchOnce();
  } finally {
    autoSwitchRunning = false;
  }
}
let versionEvents = null;
// Migration quiet windows (quiet-windows.cjs), or null when its record could not be opened: then none is opened.
let quietWindows = null;
// What this start brought and the backends still on an old version, with what each waits for, told once and again
// as each moves or fails (version-events.cjs). The window's state as pushed, no refresh: a report, not a move.
function observeVersion() {
  if (!versionEvents?.pending()) return;
  const c = [...windows.values()].find(context => !context.background && !context.win.isDestroyed() && !context.client.closing && !context.client.socket.destroyed);
  if (!c) return;
  const settings = backendSwitch.readSettings(dataDir), version = app.getVersion(), now = Date.now();
  const sessions = roomState.apply(c.client.snapshot()).sessions;
  const humanAt = queueDispatcher ? queueDispatcher.humanAt : new Map();
  const behind = connectionUpdateOptions(c.client, version, roomState).map(option => {
    let wait;
    if (backendSwitching === option.backendKey) {
      wait = { code: 'moving' };
    } else if (!(settings.auto || settings.migrate)) {
      wait = { code: 'needs-person' };
    } else if (option.ready && !autoSwitchFailed.has(option.backendKey)) {
      // All its sessions ended: continued at the next automatic pass.
      wait = { code: 'next' };
    } else {
      wait = queueRules.moveWait(option, settings, sessions, humanAt, now, autoSwitchFailed, migrateQuietMs(), migrateUnprovenQuietMs()) || { code: 'next' };
    }
    return { key: option.backendKey, version: option.version, sessions: option.sessions, wait };
  });
  const placed = new Map();
  for (const entry of c.client.entries) {
    for (const s of entry.state.sessions || []) {
      if (!placed.has(s.id) || entry.state.runtimeVersion === version) placed.set(s.id, entry.state.runtimeVersion);
    }
  }
  versionEvents.observe(behind, id => placed.get(id));
}
// Only a verified isolated test run may shorten how long sessions stay quiet before a migration.
function migrateQuietMs() {
  const test = Number(process.env.NAW_TEST_MIGRATE_QUIET_MS);
  if (backgroundTest && Number.isSafeInteger(test) && test >= 0) {
    return test;
  }
  return queueRules.MIGRATE_QUIET_MS;
}
function migrateUnprovenQuietMs() {
  const test = Number(process.env.NAW_TEST_MIGRATE_UNPROVEN_QUIET_MS);
  if (backgroundTest && Number.isSafeInteger(test) && test >= 0) {
    return test;
  }
  return queueRules.MIGRATE_UNPROVEN_QUIET_MS;
}
// One pass over the quiet windows by the move's own inputs; one that ended without its move is told as the version events are.
function passQuietWindows(input) {
  if (!quietWindows) return;
  let result;
  try { result = quietWindows.pass(input); } catch { return; }
  for (const window of result.closed) {
    if (!['timeout', 'person', 'still-busy'].includes(window.code)) continue;
    // Who still holds the move, by the same rule, so the line names them.
    let held = null;
    try {
      const option = input.options.find(o => `backend:${o.backendKey}` === window.scope);
      const wait = option && queueRules.moveWait(option, input.settings, input.sessions, input.humanAt, Date.now(), input.failed, input.quietMs, input.unprovenQuietMs);
      if (wait) held = { sessions: option.sessions || [], wait };
    } catch { held = null; }
    try { versionEvents?.quietWindowEnded(window, held); } catch { /* Kept in its record. */ }
  }
}
function quietWindowMoved(key, code) {
  try { quietWindows?.moved(key, code); } catch { /* Readers stop at its deadline. */ }
}
async function autoBackendSwitchOnce() {
  const settings = backendSwitch.readSettings(dataDir);
  // The person turned migration off: an open window closes now.
  if (!settings.migrate && quietWindows?.windows.length) passQuietWindows({ options: [], settings, sessions: [], humanAt: new Map(), failed: autoSwitchFailed });
  if (quitting || backendSwitching || !(settings.auto || settings.migrate)) return;
  const c = [...windows.values()].find(context => !context.background && !context.win.isDestroyed() && !context.client.closing && !context.client.socket.destroyed);
  if (!c) return;
  await c.client.refresh();
  const sessions = roomState.apply(c.client.snapshot()).sessions;
  let humanAt = new Map();
  if (queueDispatcher) {
    humanAt = queueDispatcher.humanAt;
  }
  const options = connectionUpdateOptions(c.client, app.getVersion(), roomState);
  passQuietWindows({ options, settings, sessions, humanAt, failed: autoSwitchFailed, quietMs: migrateQuietMs(), unprovenQuietMs: migrateUnprovenQuietMs() });
  const ready = options.find(option => option.ready && !autoSwitchFailed.has(option.backendKey));
  if (ready) {
    const backend = { version: ready.version, sessions: ready.sessions };
    let notice;
    try {
      const target = c.client.route(ready.id), guard = c.client.operationGuard(target);
      await runConnectionContinuation(c, ready.id, { target, guard, nativeId: ready.nativeId, version: ready.version, expected: ready });
      notice = { backend };
    } catch (error) {
      autoSwitchFailed.add(ready.backendKey);
      notice = error.continuationReconnectFailed ? { backend, reconnectFailed: true }
        : { backend, error: error.message || '后台更新未完成。', errorUiMessage: error.message ? uiLocale.displayMessage(error.uiMessage) : uiError('error.backendAutoUpdateIncomplete').uiMessage };
    }
    for (const context of windows.values()) sendToPage(context, 'workspace:backend-switched', notice);
    return;
  }
  const option = queueRules.nextBackendMove(options, settings, sessions, humanAt, Date.now(), autoSwitchFailed, migrateQuietMs(), migrateUnprovenQuietMs());
  if (!option) return;
  // A move made under the person's migration setting rather than proven automatic updates.
  const viaMigration = !(settings.auto && option.switch.auto);
  let notice;
  const screens = [];
  const startedAt = Date.now();
  try {
    const extra = {};
    if (!option.switch.auto) {
      // Under maintenance first, so no NAW input starts a turn while the screens are saved.
      extra.beforeStops = async () => {
        for (const stop of option.switch.stops || []) {
          const session = sessions.find(value => value.id === stop.id);
          // Typed into, or unreported: keep what the terminal shows before the process ends.
          if (session && session.terminalInputPending !== false) {
            let file = null;
            try {
              // Through the old backend's own connection: the window's client refuses input under maintenance.
              file = await queueRules.saveTerminalScreen(owner => connectService(path.join(dataDir, option.backendKey), owner), 'naw-migration', path.join(dataDir, 'rotation-terminals'), stop.id, Date.now());
            } catch {
              throw uiError('error.migrationScreenUnsaved', { name: stop.name });
            }
            if (file) {
              screens.push(file);
            }
          }
        }
      };
      // Work that started meanwhile (a turn, a running child, a goal) stops the move.
      extra.guard = record => queueRules.migrationReady(record, humanAt, Date.now(), migrateQuietMs(), migrateUnprovenQuietMs());
    }
    const result = await runBackendSwitch(c, option, option.switch.auto === true, extra);
    quietWindowMoved(option.backendKey, 'moved');
    notice = { resumed: result.resumed.length, left: result.left.length, reconnectFailed: result.reconnectFailed };
    if (viaMigration) {
      recordMigration(option, screens, result);
    }
  }
  // A failed automatic move is not retried in this app run; the person can still click.
  catch (error) {
    autoSwitchFailed.add(option.backendKey);
    quietWindowMoved(option.backendKey, 'move-failed');
    notice = { error: error.message || '后台更新未完成。', errorUiMessage: error.message ? uiLocale.displayMessage(error.uiMessage) : uiError('error.backendAutoUpdateIncomplete').uiMessage };
    recordMigrationFailure(option, screens, error, startedAt);
  }
  for (const context of windows.values()) sendToPage(context, 'workspace:backend-switched', notice);
}
let backendSwitchTimer;
async function boot() {
  dataDir = app.getPath('userData'); fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 }); fs.chmodSync(dataDir, 0o700);
  discoveries ||= regularPopup.create({ directory: dataDir, changed: (value, popup) => {
    for (const c of windows.values()) if (!c.background && !c.win.isDestroyed()) sendToPage(c, 'workspace:discoveries', { ...value, popup });
  }, notify: ({ count }) => { if (Notification.isSupported()) new Notification({ title: displayText('discoveries.title'), body: displayText('discoveries.notification', { count }) }).show(); } });
  discoveries.start();
  try {
    currentTempReminders().status().catch(() => recordsChanged(true));
  } catch { tempReminders = null; }
  if (!outboxBroker) {
    const descriptorFile = path.join(dataDir, 'outbox-owner.json');
    delete process.env.NAW_OUTBOX_DESCRIPTOR;
    try {
      const acquireAX = require('./native-accessibility.cjs').createAccessibilityScope(app, id => BrowserWindow.getAllWindows().some(win =>
        !win.isDestroyed() && win.getMediaSourceId().split(':')[1] === String(id)));
      outboxBroker = await createOutboxBroker({ descriptorFile, acquireAccessibility: target => acquireAX(target.windowId),
        windowFrames: (includeLocalPages, includeElectron) => require('./window-frames.cjs').windowFrames(
          windows.values(), includeLocalPages ? localPages?.windows() ?? [] : undefined,
          includeElectron ? BrowserWindow.getAllWindows() : undefined),
        bind: (identity, args, signal) => bindOriginalOutbox({ contexts: () => windows.values(), roomState }, identity, args, signal),
        bindControl: (identity, args, signal) => bindOriginalControl({ contexts: () => windows.values(), roomState }, identity, args, signal),
        control: async (binding, args) => {
          if (!backgroundControl) throw Error('Background control storage is unavailable');
          // The butler's own calls are written to 「大管家的记录」 first (steward-record.cjs); others run as they are.
          const result = await (stewardRecord ? stewardRecord.around(binding.sender, args, () => backgroundControl.call(binding, args)) : backgroundControl.call(binding, args));
          // A refused butler call is an event that wakes it; one that went through lets refusals wake it again (steward-wake.cjs).
          try { if (butlerIngress?.controlResult(binding.sender, args, result, { steward: () => stewardRole?.current() }) === 'succeeded') stewardWake?.controlSucceeded(); }
          catch { /* The answer goes back as it is. */ }
          // The agent gets its answer without NAW's own guard (queue 794d3cd7).
          return background.agentReply(result);
        },
        createView: createStockOutboxView });
      process.env.NAW_OUTBOX_DESCRIPTOR = descriptorFile; outboxUnavailable = false;
    } catch { outboxUnavailable = true; } // Existing warning surface; never block ordinary app startup.
  }
  sessionLabels = new SessionLabels(dataDir);
  roomState = new RoomState(dataDir);
  // The butler stays outside every space, by any way of joining (steward step 2, batch 2).
  roomState.joinGuard = id => keepStewardOutside(id, true);
  try {
    // One writer owns the display-measurement epoch. It neither starts a model
    // nor opens the separate working-day recording period.
    if (!butlerIngress) {
      const ledger = new ButlerLedger(dataDir, { authorizePerson: isCurrentHumanContext });
      butlerIngress = new ButlerIngress(dataDir, { roomState, ledger });
      butlerIngress.ledger.openQuestionMetricEpoch(randomUUID());
    } else butlerIngress.roomState = roomState;
    butlerIngress.recover();
    personActions ||= new PersonActions({ ingress: butlerIngress });
  }
  catch { /* Sources stay in the committed room events; status remains blocked. */ }
  bindQueueOutcomes(roomState, butlerIngress, notifyQueueOutcome);
  try { butlerReadAudit ||= new ButlerReadAudit(dataDir, { authorizePerson: isCurrentHumanContext }); }
  catch { /* Read-audit failure blocks model reads, not ordinary sessions or B1. */ }
  try { butlerBackend = createDedicatedBackend(path.join(dataDir, 'butler-native'), {
    runtimeVersion: app.getVersion(), executablePath: process.execPath }); }
  catch { butlerBackend = null; } // Dedicated failure must not stop ordinary sessions.
  // No prepare/ensure/controller here. Activation and the record period stay off.
  // Person-only source controls reuse the existing ledger; construction does
  // not check credentials, start a runner or add records to ordinary state.
  try {
    butlerRole ||= new ButlerRole(dataDir, { authorizePerson: isCurrentHumanContext });
    if (!butlerPerson) butlerPerson = new ButlerPerson({ role: butlerRole, ledger: butlerIngress?.ledger,
      backend: butlerBackend, credentialPresent: butlerCredentialPresent, authorizePerson: isCurrentHumanContext });
    else { butlerPerson.ledger = butlerIngress?.ledger; butlerPerson.backend = butlerBackend; }
  } catch { butlerPerson = null; } // Keep B1 and ordinary sessions independent.
  queueSecretary = new QueueSecretary(dataDir);
  // Who the person designated as integrator. A record only: nothing is sent to it from here.
  integratorRole = new IntegratorRole(dataDir);
  // Who the person designated as the butler they talk to; what it lets that session do is listed in steward-role.cjs.
  stewardRole = new StewardRole(dataDir);
  stewardStanding = new StewardStanding(dataDir, { role: stewardRole, person: isCurrentHumanContext });
  // What the butler does through NAW, under its own name (steward step 2, batch 1). One that cannot be read stops
  // only the butler's calls, and the bell says so.
  stewardOf = stewardRecords.cachedSteward(stewardRole);
  // One writer for the run: a retried start keeps it, unless it could not be opened.
  if (!stewardRecord || stewardRecord.loadError) stewardRecord = new stewardRecords.StewardRecord(dataDir, { steward: () => stewardOf(), selected: () => stewardRole.selected, failed: () => recordsChanged() });
  if (!stewardRecord.failed) try { stewardRecord.sync(stewardOf()); } catch { /* Said again when the record is opened or the butler acts. */ }
  // Its lines go to that record under NAW's name; one that cannot be written sends nothing. The switch holds for the
  // person's designation, which a rotation keeps.
  try {
    stewardWake ||= new StewardWake(dataDir, { ledger: () => butlerIngress?.ledger || null, selected: () => stewardRole.selected,
      changed: stewardWakeChanged, asker: event => asker(backgroundControl?.recordsOf(event.payload.memberId) || [], event),
      record: line => { if (!stewardRecord) throw Error('The butler record is unavailable'); stewardRecord.append(line); } });
  } catch { stewardWake = null; }
  try { quietWindows ||= new QuietWindows(dataDir, { moveWait: queueRules.moveWait }); } catch { quietWindows = null; }
  // The version this start brought, told to the butler and the queue secretary (version-events.cjs): one per app run.
  try {
    versionEvents ||= new VersionEvents(dataDir, { version: app.getVersion(), run: runMark,
      record: event => {
        if (!butlerIngress) throw Error('The butler record is unavailable');
        butlerIngress.record(event);
      },
      owe: text => {
        const secretary = queueSecretary.current(), steward = stewardRole.current();
        // A secretary that is also the butler reads it in its event record.
        if (!secretary || steward && steward.sessionId === secretary.sessionId) return false;
        return versionNotices.add(secretary, text);
      } });
  } catch { versionEvents = null; }
  const defaultWorkspace = process.env.NAW_WORKSPACE || path.join(dataDir, 'workspace');
  creationDefaults = new CreationDefaults(dataDir, { defaultWorkspace, newWorkspaceRoot: `${path.resolve(defaultWorkspace)}-sessions` });
  viewStore = new ViewStore(dataDir);
  const loaded = dropRetiredViewFields(viewStore.load());
  views = loaded.views;
  try { backgroundControl ||= new background.BackgroundControl({ dataDir, handlers: applicationHandlers, changed: change => { observePersonActions(); backgroundNotifications?.sync(); broadcastRoom().catch(() => {}); recordsChanged(change?.confirmations === true); },
    confirmationFingerprint: (row, snapshot, view, live) => backgroundOperation.controlFingerprint(row.command,
      { state: snapshot, actor: row.actor, context: live || { view }, roomState, sessionLabels, client: live?.client }),
    confirmationPending: notifyBackgroundConfirmation,
    decided: (actor, receipt, decision) => answerNotices.add(actor, receipt, decision),
    receiptRead: (actor, id) => answerNotices.read(actor, id),
    project: projectBackgroundRecord,
    confirmation: (actor, command, action, context) => {
      // Validate only input shape and the owned in-memory token before asking.
      // File metadata/content stays behind the person's existing confirmation.
      if (command.method === 'saveLocalFile' && (!context.filePreview || context.filePreview.token !== command.arguments[0] || context.fileSaving)) throw new background.PreconditionRefused(uiError('error.main.filePreviewChanged'), 'file-preview-changed');
      const onePath = ['openLocalFile', 'saveLocalFile'].includes(command.method) || command.method === 'runtimeLocation' && command.arguments[1] !== true;
      if (onePath && command.paths?.length !== 1) throw new background.PreconditionRefused(uiError('error.background.oneFilePathRequired'), 'invalid-file-path-count');
      if (command.method === 'spaceFiles' && command.arguments[1] === undefined && !command.paths?.length) throw new background.PreconditionRefused(uiError('error.background.importPathsRequired'), 'invalid-file-path-count');
      if ((action === 'readConversation' || ['terminalSnapshot', 'observe', 'terminal'].includes(command.method) && command.arguments[0] !== actor.id) &&
          !conversationReaderAllowed(actor)) throw new background.PreconditionRefused(uiError('error.background.secretaryConversation'), 'conversation-access-denied');
      if (command.method === 'spaceFiles' && command.arguments[1] !== undefined) {
        const access = conversationAccess(actor, context.client.snapshot());
        if (access.secretary || !access.roomIds.includes(command.arguments[0])) throw new background.PreconditionRefused(uiError('error.background.spaceFileMembership'), 'space-file-membership-required');
      }
      const state = sessionLabels.apply(roomState.apply(context.client.snapshot()));
      const firstMessage = command.method === 'create' && backgroundOperation.creationMessage(command.arguments[0]);
      const target = state.sessions.find(s => s.id === backgroundOperation.conversationTarget(command.method, command.arguments, actor));
      if (action === 'changeModel') {
        const session = state.sessions.find(s => s.id === command.arguments[0]);
        const refusal = command.arguments.length !== 2 ? uiError('error.modelChange.unknown', { model: '' })
          : require('./session-model.cjs').refused(session, session?.serviceCapabilities || state.capabilities, command.arguments[1]);
        if (refusal) throw new background.PreconditionRefused(refusal, 'model-change-unavailable');
      }
      if (action === 'readConversation' && !target) throw new background.PreconditionRefused(uiError('error.background.conversationChanged'), 'conversation-target-unavailable');
      return { type: 'warning',
      message: action === 'readConversation' ? displayText('background.readConversationTitle', { name: backgroundOperation.visibleText(actor.name), target: backgroundOperation.visibleText(target.name) })
        : displayText('background.maintenanceTitle', { name: backgroundOperation.visibleText(actor.name), command: displayText('background.action.' + (firstMessage ? 'createWithFirstMessage' : action)) }),
      detail: [backgroundOperation.confirmationDetail(command, state, context), ...(action === 'archiveRoom' ? [roomArchiveDetail(state, command.method === 'spaceAction' ? command.arguments[0] : 'shared')] : [])].join('\n\n'),
      buttons: [displayText('common.cancel'), displayText('background.confirm')], defaultId: 0, cancelId: 0 }; },
    audit: auditBackgroundOperation,
    unasked: (actor, _command, action, context) => action === 'readConversation' && stewardReadsUnasked(actor, context.client.snapshot()),
    retireHold: () => (outboxBroker?.active?.() || 0) > 0,
    standing: (actor, command, context) => {
      const state = sessionLabels.apply(roomState.apply(context.client.snapshot()));
      const grant = stewardStanding.take(actor, command, state, context.view.spaceId || 'shared');
      if (!grant) return null;
      const action = backgroundOperation.maintenanceAction(command.method, command.arguments, actor);
      const old = state.sessions.find(s => s.id === command.arguments[0]);
      const room = state.rooms.find(r => r.id === (command.method === 'spaceAction' ? command.arguments[0] : 'shared'));
      const kind = ['create', 'spaceCreate'].includes(action) ? 'created' : ['joinRoom', 'leaveRoom'].includes(action) ? 'placement'
        : ['rename', 'renameRoom'].includes(action) ? 'rename' : ['archiveSession', 'archiveRoom'].includes(action) ? 'archived'
        : ['restoreSession', 'restoreRoom'].includes(action) ? 'restored' : 'order';
      const target = grant.summary?.name || grant.summary?.target || grant.summary?.room || room?.name || displayText('standing.newSession');
      return { ...grant, actionText: displayText('background.action.' + action),
        target: grant.creation ? displayText('standing.creationTarget', { target, model: grant.creation.model ?? displayText('standing.nativeDefault'),
          effort: grant.creation.effort ?? displayText('standing.nativeDefault') }) : target,
        undo: displayText('standing.undo.' + kind, { previous: kind === 'order' ? (room?.memberOrder || []).map(id => state.sessions.find(s => s.id === id)?.name || id).join('、') : old?.name || room?.name || '',
          home: (grant.before.rooms || []).map(id => state.rooms.find(r => r.id === id)?.name || '').filter(Boolean).join('、') || displayText('sidebar.independent') }) };
    },
    standingValid: (actor, command, context, grant) => stewardStanding.valid(actor, command,
      sessionLabels.apply(roomState.apply(context.client.snapshot())), context.view.spaceId || 'shared', grant),
    inputDelivery: (id, owner, seen) => require('./workspace-client.cjs').consentedInputBlocked(dataDir, id, owner, seen),
    standingFallback: (actor, command, context) => stewardStanding.fallback(actor, command,
      sessionLabels.apply(roomState.apply(context.client.snapshot())), context.view.spaceId || 'shared'),
    context: async (actor, saved, kept) => {
      const view = saved || { owner: randomUUID(), selected: actor.id, mode: 'chat', preference: 'chat', active: false };
      backups(view);
      // No one sees this window: the service never counts it as one that holds a session.
      const client = await connect(dataDir, view.owner, { page: false });
      const win = new BrowserWindow({ ...windowOptions(), show: false, focusable: false, skipTaskbar: true });
      const context = { background: true, actor, win, client, view, failed: false };
      // What this agent's next background window takes over when this one is closed for lack of use. Not while a
      // file is being chosen or saved. Image previews are not carried: their tokens are refused once the window closes.
      Object.assign(context, kept);
      context.retain = () => context.fileChoosing || context.fileSaving ? null :
        Object.fromEntries(RETAINED_CONTEXT.filter(name => context[name] !== undefined).map(name => [name, context[name]]));
      context.metadataOnly = () => !conversationReaderAllowed(actor);
      context.refresh = () => client.refresh();
      context.confirmationActors = () => controlRequestActors(client);
      context.terminalConsentSnapshot = () => confirmationSnapshot(client, roomState.apply(client.snapshot()));
      context.checkActor = async () => {
        await context.refresh();
        const record = context.confirmationActors().find(s => s.id === actor.id);
        if (!record || record.nativeId !== actor.nativeId || record.archived || record.nativeContextPending) throw Error('The originating native session changed');
      };
      context.fingerprint = command => {
        return backgroundOperation.controlFingerprint(command, { state: client.snapshot(), actor, context, roomState, sessionLabels, client });
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
      win.on('closed', () => { windows.delete(id); context.imagePreviews?.close(); client.close(); });
      return context;
    } }); backgroundUnavailable = false; operationsUnavailable = null;
  } catch (error) { backgroundUnavailable = true; operationsUnavailable = /history cannot be read/.test(String(error?.message)) ? 'history' : 'other'; recordsChanged(); }
  if (loaded.changed) saveViews();
  process.env.NAW_RUNTIME_CONFIG = path.join(dataDir, 'runtime-locations.json');
  await ensureService(dataDir, process.execPath);
  await startQueueDispatcher();
  try { modelChanges().schedule(); } catch { /* A later request tries again. */ }
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
  register('backgroundWithdraw', (c, id) => {
    if (!c.background) throw uiError('error.background.withdrawNotPending');
    return backgroundControl.withdraw(c.actor, id, c);
  });
  register('operatorAction', (c, id, action, value) => {
    if (c.background && action === 'quota') throw uiError('error.operator.personOnlyQuota');
    return c.client.call('operatorAction', id, action, value);
  });
  for (const name of ['prepareInput', 'observe', 'unobserve', 'claim', 'terminal', 'terminalSnapshot', 'input', 'resize', 'interrupt', 'pause', 'approve', 'answer', 'wakePolicy']) register(name, (c, ...args) => {
    if (['prepareInput', 'claim', 'terminal', 'input', 'approve', 'answer'].includes(name)) roomState.assertAvailable(args[0]);
    const approved = c.background && backgroundOperation.request()?.approved;
    // Only a card the person confirmed carries a confirmation into input; a caller's own fourth argument is dropped.
    if (name === 'input') return approved ? c.client.call(name, args[0], args[1], { proof: approved.terminalConsent, expiresAt: approved.expiresAt }) : c.client.call(name, args[0], args[1]);
    return c.client.call(name, ...args);
  });
  register('retrySave', async c => {
    if (viewStorageWarning) saveViews();
    // The window record is independent of provider/service availability.
    if (!c.client.socket.destroyed && (await c.client.call('initial')).storageRetryable) await c.client.call('retrySave');
    return true;
  });
  register('join', async (c, id, join) => {
    keepStewardOutside(id, join);
    try { await roomState.membership(c.client, id, join, sessionLabels.labels.get(id)); }
    finally { await broadcastRoom(); }
  });
  register('roomRename', async (_c, name) => { roomState.rename(name); await broadcastRoom(); });
  register('roomNotes', async (c, text, revision) => { roomState.notes(text, revision, undefined, { person: isCurrentHumanContext(c) }); await broadcastRoom(); });
  register('roomMemberOrder', async (c, change) => {
    const snapshot = await c.client.call('initial');
    roomState.moveMember(change, snapshot.sessions); await broadcastRoom();
  });
  register('archiveSession', async (c, id) => { try { await roomState.archiveSession(c.client, id, sessionLabels.labels.get(id)); } finally { await broadcastRoom(); } });
  register('restoreSession', async (c, id) => {
    try { return await roomState.restoreSession(c.client, id, sessionLabels.labels.get(id)); }
    finally { await broadcastRoom(); }
  });
  register('archiveRoom', async c => { try { return await archiveRoomConfirmed(c); } finally { await broadcastRoom(); } });
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
      keepStewardOutside(args[0], args[1]);
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
    else if (action === 'notes') roomState.notes(args[0], args[1], roomId, { person: isCurrentHumanContext(c), attach: args[2] });
    else if (action === 'memberOrder') roomState.moveMember(args[0], (await c.client.call('initial')).sessions, roomId);
    else if (action === 'archive' || action === 'restore') {
      try { return action === 'archive' ? await archiveRoomConfirmed(c, roomId) : await roomState.restoreRoom(c.client, sessionLabels.labels, roomId); }
      finally { await broadcastRoom(); }
    } else if (action === 'removeFile') roomState.removeFile(args[0], args[1], roomId);
    else if (action === 'releaseRotation') {
      const steward = c.background ? await stewardCaller(c) : null;
      if (c.background ? !steward : !isCurrentHumanContext(c)) throw uiError('error.queue.personOnly');
      if (args.length !== 5) throw uiError('error.invalidSpaceAction');
      const snapshot = roomState.apply(await c.client.call('initial'));
      const member = snapshot.sessions.find(s => s.id === args[0]);
      if (!member || member.archived) throw uiError('error.workspace.handoffExpired');
      const memberships = roomIds(member);
      if (memberships.length ? !memberships.includes(roomId) : roomId !== 'shared') throw uiError('error.workspace.handoffExpired');
      const actor = steward ? { kind: 'steward', id: steward.id } : { kind: 'person', id: c.view.owner };
      const result = await queueDispatcher.releaseRotation(...args.slice(0, 4), actor, args[4]);
      await broadcastRoom(); return result;
    }
    else if (['queueAdd', 'queueCancel', 'queueResolve', 'queueClaim'].includes(action)) {
      // Besides the person: the secretary adds; the butler adds, cancels and marks handled, each under its own name;
      // a session takes back what it queued itself while it is still queued (the person, 11-12 21:1x: 「可以」);
      // a session claims an item queued for it that it is already doing, so that NAW does not send it again (6897c6e3).
      const steward = c.background ? await stewardCaller(c) : null;
      if (c.background && !steward && action === 'queueResolve') throw uiError("error.queue.personOnly");
      const by = steward ? 'steward' : null;
      // The backend's own list does not say which sessions the person archived; the desktop's record does.
      const sessions = async () => roomState.apply(await c.client.call('initial')).sessions;
      if (action === 'queueAdd') {
        // An assignee that is not a current member of this space is refused before anything is added, with the
        // members' names and ids, so that the item is never left queued for nobody (11-12, item 87a3b4c0).
        const assignee = args[1] ?? null;
        if (assignee !== null) {
          const refusal = queueRules.assigneeRefusal(assignee, { id: roomId, memberOrder: roomState.metadata(roomId).memberOrder },
            await sessions(), session => sessionLabels.labels.get(session.id) || session.name || session.id);
          if (refusal) throw refusal;
        }
        // The butler's items keep the creator form older builds read (a session that added it); `addedBy` says who.
        const creator = steward ? { kind: 'secretary', name: steward.name, sessionId: steward.id } : c.background
          ? queueSecretary.creator(backgroundOperation.current(), await sessions(), sessionLabels.labels)
          : { kind: 'person', name: 'You', sessionId: null };
        const itemId = roomState.queueAdd(args[0], args[1] ?? null, roomId, creator, by);
        await broadcastRoom();
        queueDispatcher?.schedule();
        return itemId;
      }
      if (action === 'queueClaim') {
        // Only a session claims, and only for itself: the person's window has no session of its own here.
        if (!c.background) throw uiError("error.queue.claimOwnOnly");
        const list = await sessions();
        const member = queueSecretary.author(backgroundOperation.current(), list, sessionLabels.labels, 'error.queue.claimOwnOnly');
        const record = list.find(session => session.id === member.sessionId);
        // As for an item NAW sends: its reply is what follows the input this turn began with, and a change of control since counts.
        const input = (record.messages || []).findLast(message => message?.role === 'user');
        if (require('./submission-policy.cjs').rotationBlocked(record)) throw uiError('error.queue.claimBusy');
        roomState.queueClaim(args[0], roomId, { ...member, control: record.controlRevision || 0, input: input?.id,
          nativeId: record.nativeId, claimEpoch: require('./submission-policy.cjs').rotationEpoch(record) });
        queueDispatcher?.schedule();
      }
      else if (action === 'queueCancel' && c.background && !steward) roomState.queueWithdraw(args[0], roomId, queueSecretary.author(backgroundOperation.current(), await sessions(), sessionLabels.labels));
      else if (action === 'queueCancel') roomState.queueCancel(args[0], roomId, by);
      else {
        // The answer sent from the person's own window (search-view.js queueAnswerResolve); no agent records one.
        const answer = args[1] ?? undefined;
        if (answer !== undefined && c.background) throw uiError("error.queue.personOnly");
        // The session whose native receipt the window saw: a decision may have gone to a successor meanwhile.
        const recipient = args[2] ?? undefined;
        if (recipient !== undefined && typeof recipient !== 'string') throw uiError("error.queue.invalid");
        // The message row the window saw delivered: the reply that follows it is recorded on this item.
        const tag = args[3] ?? undefined;
        if (tag !== undefined && typeof tag !== 'string') throw uiError("error.queue.invalid");
        if (answer === undefined) roomState.queueResolve(args[0], roomId, by); else roomState.queueResolve(args[0], roomId, by, answer, recipient, tag);
        queueDispatcher?.schedule();
      }
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
      await assertSpaceFileReader(c, roomId);
      const file = value.files.find(f => f.id === fileId); if (!file) throw uiError("error.main.fileReferenceChanged");
      const preview = await readPreview(file.path);
      await assertSpaceFileReader(c, roomId);
      if (c.win.isDestroyed() || !roomState.metadata(roomId).files.some(f => f.id === fileId && f.path === file.path)) throw uiError("error.main.spaceFileListChanged");
      // Hosted space reads use the one-use read cache, never an export buffer.
      c.filePreview = c.background ? null : preview;
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
  register('createDefaults', async c => {
    const revision = c.worktreePreviewRevision = (c.worktreePreviewRevision || 0) + 1;
    c.worktreePlan = null;
    const snapshot = await c.client.call('initial'), defaults = creationDefaults.get(snapshot.sessions);
    if (!c.win.isDestroyed() && c.worktreePreviewRevision === revision) c.worktreeSource = defaults.repository;
    return defaults;
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
    const state = await c.client.call('initial');
    assertNativeCreation(state);
    let defaults = args[0];
    const firstMessage = backgroundOperation.creationMessage(defaults);
    const request = backgroundOperation.request();
    if (firstMessage !== null) {
      if (!c.background || !request?.approved || request.args.method !== 'create' || !request.maintenanceApproved) {
        throw uiError('error.background.firstMessageNeedsConfirmation');
      }
      if (!state.capabilities?.includes('firstMessageGuardV1')) throw uiError('error.background.firstMessageBackend');
      if (state.wakePolicy?.enabled !== true) throw uiError('error.backgroundMessagesDisabled');
    }
    if (args[0]?.gitWorktree != null) {
      const requested = args[0].gitWorktree, plan = c.worktreePlan;
      if (!plan || Object.keys(requested).length !== Object.keys(plan).length || Object.keys(plan).some(key => requested[key] !== plan[key])) throw uiError("error.main.worktreePreviewExpired");
      c.worktreePlan = null;
      defaults = { ...args[0], gitWorktree: plan };
    }
    const options = firstMessage === null ? defaults : { ...defaults, view: 'chat' };
    if (firstMessage !== null) delete options.initialMessage;
    const id = await c.client.call('create', options, ...args.slice(1));
    if (firstMessage !== null) {
      try {
        await request.valid();
        const target = roomState.apply(c.client.snapshot()).sessions.find(s => s.id === id);
        if (!target?.nativeId) throw uiError('error.background.firstMessageChanged');
        const receipt = await c.client.call('send', id, firstMessage, target.nativeId, { firstMessageUntil: request.approved.expiresAt });
        if (typeof receipt !== 'string' || !receipt) throw uiError('error.background.firstMessageChanged');
      } catch (error) {
        throw uiError('error.background.firstMessageUnconfirmed', { id, reason: error.message }, { cause: error, param: 'reason' });
      }
    }
    if (!c.background) { try { creationDefaults.remember(defaults); } catch { /* Creating a session succeeded even if optional defaults cannot be saved. */ } }
    return id;
  });
  register('nativeHistory', (c, options) => c.client.call('nativeHistory', options));
  register('importHistory', (c, nativeId, options) => c.client.call('importHistory', nativeId, options));
  register('butlerReview', (c, action, ...args) => {
    try {
    if (!isCurrentHumanContext(c)) throw Object.assign(Error('Only the current person window can review butler records'), { code: 'BUTLER_PERSON_ONLY' });
    const invalid = () => { throw Object.assign(Error('Invalid butler review request'), { code: 'BUTLER_REVIEW_REQUEST' }); };
    const token = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\s\u0000-\u001f\u007f]/u.test(value);
    if (!['availability', 'latest', 'read', 'freeze', 'confirm', 'reads'].includes(action)) invalid();
    if (['availability', 'latest', 'freeze'].includes(action)) { if (args.length) invalid(); }
    else if (action === 'read') { if (args.length !== 1 || !token(args[0])) invalid(); }
    else if (action === 'reads') {
      const value = args[0];
      if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value) ||
          Object.keys(value).some(key => !['afterSequence', 'limit'].includes(key)) ||
          value.afterSequence !== undefined && (!Number.isSafeInteger(value.afterSequence) || value.afterSequence < 0) ||
          value.limit !== undefined && (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 50)) invalid();
    }
    else {
      const value = args[0], fields = ['reviewId', 'contentDigest', 'expectedRevision', 'disagreedSuggestionIds', 'disagreedCandidateIds', 'allRead'];
      if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value) ||
          Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key)) ||
          Object.keys(value).some(key => !fields.includes(key)) || !token(value.reviewId) || !token(value.contentDigest) ||
          !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0 || value.allRead !== true ||
          !Array.isArray(value.disagreedSuggestionIds) || !value.disagreedSuggestionIds.every(token) ||
          !Array.isArray(value.disagreedCandidateIds) || !value.disagreedCandidateIds.every(token)) invalid();
    }
    if (action === 'reads') {
      if (!butlerReadAudit) throw uiError('error.butler.readAuditUnavailable');
      try { return butlerReadAudit.read(c, args[0]); }
      catch { throw uiError('error.butler.readAuditUnavailable'); }
    }
    const ledger = butlerIngress?.ledger;
    let available = Boolean(ledger && ['healthy', 'hasReviewData', 'freezeReview', 'latestReview', 'review', 'confirmReview'].every(name => typeof ledger[name] === 'function'));
    if (action === 'availability') {
      let hasData = false;
      if (available) { try { ledger.healthy(); hasData = ledger.hasReviewData(c) === true; } catch { available = false; } }
      return { available, hasData: available && hasData, activation: 'off', recordPeriod: 'off' };
    }
    if (!available) throw Object.assign(Error('Butler review storage is unavailable'), { code: 'BUTLER_REVIEW_UNAVAILABLE' });
    if (action === 'latest') return ledger.latestReview(c);
    if (action === 'read') return ledger.review(args[0], c);
    if (action === 'freeze') return ledger.freezeReview({ afterSequence: 0 }, c);
    const { reviewId, ...request } = args[0];
    return ledger.confirmReview(reviewId, request, c);
    } catch (error) {
      // Preserve the existing structured display-error path through sandboxed
      // preload; generic IPC intentionally does not forward arbitrary codes.
      const key = { BUTLER_REVIEW_REVISION: 'conflict', BUTLER_REVIEW_DIGEST: 'conflict',
        BUTLER_REVIEW_CAPACITY: 'capacity', BUTLER_PERSON_ONLY: 'personOnly',
        BUTLER_REVIEW_UNAVAILABLE: 'unavailable' }[error?.code];
      if (key) error.uiMessage = uiError('error.butlerReview.' + key).uiMessage;
      throw error;
    }
  });
  // Review records belong only to the person's renderer IPC, never the agent
  // catalog/invoke map. The handler still checks every direct IPC caller.
  applicationHandlers.delete('butlerReview');
  register('butler', async (c, action, ...args) => {
    if (!isCurrentHumanContext(c)) throw uiError('error.butler.personOnly');
    if (!butlerEntryEnabled) throw uiError('error.butler.entryDisabled');
    const validRevision = value => Number.isSafeInteger(value) && value >= 0;
    if (!['status', 'recheck', 'designate', 'revoke', 'setActive'].includes(action) ||
        (action === 'status' ? args.length !== 0 : action === 'setActive' ?
          args.length !== 2 || typeof args[0] !== 'boolean' || !validRevision(args[1]) :
          args.length !== 1 || !validRevision(args[0]))) throw uiError('error.butler.invalidRequest');
    if (!butlerPerson) throw uiError('error.butler.unavailable');
    // What leaves this process is the entry a person window draws and the plain facts of an action's result.
    // The session identity, runner and backend references, batch ids and stop targets stay here.
    const reviewData = () => { try { return butlerIngress?.ledger?.hasReviewData(c) === true; } catch { return false; } };
    const shown = view => butlerEntryHost.entry(view, { reviewAvailable: Boolean(view?.role?.selected) && reviewData() });
    try {
      if (action === 'status') return shown(butlerPerson.status(c));
      if (action === 'recheck') {
        const state = butlerPerson.status(c);
        if (!state.role.available) throw Object.assign(Error('ERR_BUTLER_STATE'), { code: 'ERR_BUTLER_STATE' });
        if (state.role.revision !== args[0]) throw Object.assign(Error('ERR_BUTLER_REVISION'), { code: 'ERR_BUTLER_REVISION' });
        return shown(butlerPerson.recheck(c));
      }
      return butlerEntryHost.outcome(await butlerPerson[action](c, ...args));
    }
    catch (error) {
      const keys = { ERR_BUTLER_PERSON: 'personOnly', ERR_BUTLER_REQUEST: 'invalidRequest',
        ERR_BUTLER_REVISION: 'changed', ERR_BUTLER_BUSY: 'busy', ERR_BUTLER_ACTIVATION_DISABLED: 'activationDisabled' };
      let key = 'unavailable'; try { const code = error?.code; if (Object.hasOwn(keys, code)) key = keys[code]; } catch {}
      throw uiError('error.butler.' + key);
    }
  });
  applicationHandlers.delete('butler');
  // The bell's reminders about records kept whole, and what the person can do about them. The person's window only;
  // no agent command (removed from the agent catalog below), and nothing here deletes a block.
  register('records', async (c, action, ...args) => {
    if (!isCurrentHumanContext(c)) throw uiError('error.records.personOnly');
    const name = args[0];
    const status = async (force = false) => {
      let temp;
      try { temp = await currentTempReminders().present(c, force); }
      catch { if (!isCurrentHumanContext(c)) throw uiError('error.records.personOnly'); temp = { id: 'naw-temp-files', version: 0, checkedAt: Date.now(), directories: 0, bytes: 0, shown: true, anomaly: 'inspection-unavailable' }; }
      return { ...appRecordsStatus(confirmationSnapshot(c.client), temp), temp };
    };
    if (action === 'status' && (args.length === 0 || args.length === 1 && args[0] === true)) return status(args[0] === true);
    if (action === 'tempClean' && args.length === 1 && tempReminders) { const result = await tempReminders.clean(c, args[0]); return { ...await status(), result }; }
    if (action === 'tempAcknowledge' && args.length === 1 && tempReminders) { await tempReminders.acknowledge(c, args[0]); return status(); }
    if (action !== 'status' && action !== 'chooseFolder' && !recordReminders.RECORDS.includes(name)) throw uiError('error.records.unknown');
    try {
      if (action === 'acknowledge' && args.length === 3) { recordReminders.acknowledge(dataDir, name, args[1], args[2]); mobileBroker?.refreshPush(); return status(); }
      if (action === 'blocks' && args.length === 1) return recordReminders.blocks(dataDir, name, Date.now());
      if (action === 'chooseFolder' && args.length === 0) {
        const result = await showDialog(c, 'open', { title: displayText('records.export.chooseTitle'), properties: ['openDirectory', 'createDirectory'] });
        if (result.canceled || c.win.isDestroyed() || !result.filePaths?.[0]) return null;
        c.recordsFolder = result.filePaths[0]; return { folder: c.recordsFolder };
      }
      if (action === 'export' && args.length === 2) {
        if (!c.recordsFolder) throw uiError('error.records.noFolder');
        const result = recordReminders.exportBlocks(dataDir, name, args[1], c.recordsFolder);
        // Only blocks exported and checked in this window may be removed afterwards.
        const prior = c.recordsExported?.[name]?.folder === result.folder ? c.recordsExported[name].names : [];
        c.recordsExported = { ...(c.recordsExported || {}), [name]: { folder: result.folder, names: new Set([...prior, ...result.exported.map(item => item.name)]) } };
        return result;
      }
      if (action === 'delete' && args.length === 2) {
        const names = args[1], exported = c.recordsExported?.[name];
        if (!exported || !Array.isArray(names) || !names.length || names.some(item => !exported.names.has(item))) throw uiError('error.records.notExported');
        recordReminders.verifyExport(dataDir, name, names, exported.folder);
        const answer = await showDialog(c, 'message', { type: 'warning', buttons: [displayText('records.delete.cancel'), displayText('records.delete.confirm')], defaultId: 0, cancelId: 0,
          message: displayText('records.delete.question', { count: names.length }), detail: displayText('records.delete.detail', { folder: exported.folder }) });
        if (answer.response !== 1 || c.win.isDestroyed()) return { deleted: [] };
        recordReminders.verifyExport(dataDir, name, names, exported.folder);
        if (name === 'operations') { if (!backgroundControl) throw uiError('error.records.unavailable'); backgroundControl.deleteBlocks(names); }
        else if (name === 'steward') { if (!stewardRecord || stewardRecord.failed) throw uiError('error.records.unavailable'); stewardRecord.deleteBlocks(names); }
        else { if (!butlerReadAudit) throw uiError('error.records.unavailable'); butlerReadAudit.deleteBlocks(c, names); }
        for (const item of names) exported.names.delete(item);
        return { deleted: names };
      }
      if (action === 'reveal' && args.length === 2) { shell.showItemInFolder(recordReminders.location(dataDir, name, args[1])); return true; }
    } catch (error) { if (error?.uiMessage) throw error; throw uiError('error.records.failed', { reason: String(error?.message || '').slice(0, 300) }); }
    throw uiError('error.records.unknown');
  });
  applicationHandlers.delete('records');
  // 「大管家的记录」: the person's window only, never an agent command (removed from the agent catalog below), so the
  // butler cannot read or shape its own record through NAW.
  // `request.limit`: how many of the latest steps the dialog lists now; it asks for more as the person goes back.
  register('stewardRecord', async (c, request = null) => {
    if (!isCurrentHumanContext(c)) throw uiError('error.stewardRecord.personOnly');
    // One that could not be opened is the bell's to explain; one that stopped taking lines still shows what it holds.
    if (!stewardRecord || stewardRecord.loadError) throw uiError('error.stewardRecord.unavailable');
    let current = null, known = true;
    try { current = stewardOf(); } catch { known = false; }
    if (known) try { stewardRecord.sync(current); } catch { /* Shown from what is recorded. */ }
    const snapshot = sessionLabels.apply(roomState.apply(await c.client.call('initial')));
    const stateOf = step => {
      const actor = { provider: step.session.provider, id: step.session.id, nativeId: step.session.nativeId };
      let r = null; try { r = backgroundControl?.receipt(actor, step.operationId) || backgroundControl?.deletedReply(actor, step.operationId) || null; } catch { r = null; }
      return r && typeof r.state === 'string' ? { state: r.state, reason: typeof r.reason === 'string' ? r.reason : r.refusalSummary?.reason ?? null, method: r.command?.method ?? null } : null;
    };
    // Whom a read step read and how far, from NAW's record of that operation (what it ran, not what was asked).
    const readOf = step => {
      const actor = { provider: step.session.provider, id: step.session.id, nativeId: step.session.nativeId };
      let r = null; try { r = backgroundControl?.receipt(actor, step.operationId) || null; } catch { r = null; }
      // The person deleted that record: what it ran is no longer known, and the step must not name a session it may not have read.
      if (!r) { try { return backgroundControl?.deletedReply(actor, step.operationId) ? { gone: true } : null; } catch { return null; } }
      if (!['initial', 'previewImage'].includes(r.command?.method)) return null;
      const sessionId = r.readTarget?.sessionId || backgroundOperation.conversationTarget(r.command.method, r.command.arguments, actor);
      if (typeof sessionId !== 'string' || sessionId === actor.id) return null;
      return { sessionId, name: r.readTarget?.name ?? null, messages: r.readTarget?.messages ?? null, through: r.readTarget?.through ?? null, unasked: r.unasked === true };
    };
    // NAW's switch for waking the butler, shown with the record so the person sees it and can turn it off.
    let wake = null; try { wake = stewardWake ? stewardWake.view() : null; } catch { wake = null; }
    const limit = request && typeof request === 'object' ? request.limit : undefined;
    return stewardRecords.view(stewardRecord, snapshot, { current: known ? current : null, stateOf, readOf, wake, limit });
  });
  applicationHandlers.delete('stewardRecord');
  register('queueSecretary', async (c, id) => {
    if (c.background) throw uiError('error.queue.personOnly');
    if (id === null) queueSecretary.set(null);
    else {
      // As above: "archived" is read from the desktop's record, not from the backend's list.
      const record = roomState.apply(await c.client.call('initial')).sessions.find(record => record.id === id);
      if (!record || !record.nativeId || record.archived || record.nativeContextPending || ['ended', 'background'].includes(record.state)) throw uiError('error.queue.secretaryInvalid');
      queueSecretary.set({ sessionId: record.id, nativeId: record.nativeId });
    }
    await broadcastRoom();
  });
  // Designating or revoking the integrator is the person's alone. The background-operation gate
  // is a fixed method table that does not know this method, so the refusal is made here.
  register('integrator', async (c, id) => {
    if (c.background) throw uiError('error.integrator.personOnly');
    if (id === null) integratorRole.set(null);
    else {
      // The backend's own list does not say which sessions the person archived; the desktop's record does.
      const record = roomState.apply(await c.client.call('initial')).sessions.find(record => record.id === id);
      if (!record || !record.nativeId || record.archived || record.nativeContextPending || ['ended', 'background'].includes(record.state)) throw uiError('error.integrator.invalid');
      // The integrator stays outside every space: a member is sent queue work, which an integrator must not get.
      let spaces;
      try { spaces = roomIds(record); } catch { throw uiError('error.integrator.invalid'); }
      if (spaces.length) throw uiError('error.integrator.inSpace');
      integratorRole.set({ sessionId: record.id, nativeId: record.nativeId });
    }
    await broadcastRoom();
  });
  // Designating, changing or revoking the butler the person talks to is the person's alone. It changes where
  // that session is listed and where the window lands at start, and which calls main.cjs takes as the butler's
  // (stewardCaller). Designating also sends the duty statement (`duty`: the person's own text, or null for the
  // default of their language) into the session as the person's message (the activation checklist, item 6).
  // `standing`: whether the person left the permission to organize (steward-standing.cjs) on for the new butler, asked
  // only while it is on for the one they have; null when they were not asked. `handoff`: what the person says to a
  // session taking over, sent in front of the duty statement this once; it is not part of the statement that is kept.
  register('steward', async (c, id, duty = null, standing = null, handoff = null) => {
    if (c.background) throw uiError('error.steward.personOnly');
    if (id !== null && duty !== null && !validDuty(duty)) throw uiError('error.steward.dutyInvalid');
    if (id !== null && handoff !== null && !validDuty(handoff)) throw uiError('error.steward.handoffInvalid');
    let record = null, standingLost = false, reached = null, takenBack = false;
    // Who held the role until now is written just before the person's choice replaces it: a rotation's successor that made
    // no call since would otherwise be missing, and with it what it sent (StewardRecord.heldRole).
    const recordHolder = () => { try { stewardRecord?.sync(stewardOf()); } catch { /* As below. */ } };
    if (id === null) { recordHolder(); stewardRole.set(null); }
    // In the queue every join runs in: no join can be half done while the session becomes the butler.
    else await roomState.serial(async () => {
      // The backend's own list does not say which sessions the person archived; the desktop's record does.
      record = roomState.apply(await c.client.call('initial')).sessions.find(record => record.id === id);
      if (!record || !record.nativeId || record.archived || record.nativeContextPending || ['ended', 'background'].includes(record.state) || midRotation(record.id)) throw uiError('error.steward.invalid');
      // The butler stays outside every space: a member is sent queue work and can be replaced by the queue.
      let spaces;
      try { spaces = roomIds(record); } catch { throw uiError('error.steward.invalid'); }
      if (spaces.length) throw uiError('error.steward.inSpace');
      const carry = stewardStanding?.carry(c, standing);
      reached = stewardWake?.reached() ?? null;
      // The same butler again keeps it: the designation may have named it only through the rotation log.
      let again = false;
      try { const now = stewardRole.current(); again = now?.sessionId === record.id && now.nativeId === record.nativeId; } catch { /* Not known to be the same one. */ }
      recordHolder();
      stewardRole.set({ sessionId: record.id, nativeId: record.nativeId }, duty);
      const keep = typeof standing === 'boolean' ? standing : again || null;
      let unsaved = false; if (carry && keep !== null) try { takenBack = carry(keep) === true; } catch { unsaved = true; }
      // Said by what holds now: a save that failed may have taken place, and a line left on may have been turned off elsewhere.
      standingLost = keep ? Boolean(carry || standing) && !stewardStanding?.view().on : unsaved;
    });
    // The designation stands even if its line cannot be written; the butler's next call is then refused.
    try { stewardRecord?.designated(id === null ? null : stewardRole.selected); } catch { /* The bell and the refused call say so. */ }
    // Taken back in this dialog is the person's off, as in their window.
    if (takenBack) try { stewardRecord?.standingSwitch(false); } catch { /* As above. */ }
    // Waking the butler on events (steward-wake.cjs) holds for the designation it was turned on for: designating or
    // revoking, the same session again included, turns it off, until the person or that butler turns it on. A
    // designation made while it was on keeps where it stood for then; a revocation keeps nothing.
    try { stewardWake?.redesignated(reached); } catch { /* A state that cannot be saved wakes nobody until it is set again. */ }
    await broadcastRoom();
    if (id === null) return null;
    // The same input the person's composer gives: to an idle session, or queued after a Claude session's running
    // turn. It is a prompt, not a permission, and handed over is not received: the message keeps its own state in the
    // butler's conversation. A refusal leaves the designation as it is and says why.
    const text = (handoff === null ? '' : handoff.trim() + '\n\n') + stewardDutyText();
    try {
      const method = record.state === 'working' && record.provider === 'claude' ? 'queue' : record.state === 'idle' ? 'send' : null;
      if (!method) throw uiError('error.steward.dutyBusy');
      const rows = () => c.client.snapshot().sessions.find(s => s.id === record.id)?.messages || [], before = new Set(rows().map(m => m.id));
      const sending = submit(c, method, record.id, text, record.nativeId);
      // Claude answers a queued message only when its running turn has ended and taken it. The person is not kept
      // waiting that long: once the message stands in the butler's conversation, waiting there, it is queued, and
      // that row keeps its own state (as the composer's queued message does). A refusal before then is said here.
      if (method === 'queue') await new Promise((resolve, reject) => {
        const settle = (done, value) => { c.client.off('state', look); done(value); };
        // This message, not one the person queued at the same moment: its own text (the workspace trims what it records).
        const look = () => { if (rows().some(m => !before.has(m.id) && m.inputMode === 'queue' && m.status === 'awaiting-native' && [text, text.trim()].includes(m.text))) settle(resolve); };
        c.client.on('state', look);
        sending.then(() => settle(resolve), error => settle(reject, error));
        look();
      });
      else await sending;
      return { duty: { state: method === 'queue' ? 'queued' : 'sent' }, ...(standingLost ? { standingLost } : {}) };
    } catch (error) {
      // Shown as a thrown error would be (the IPC reply's own step): the person's language, the same fallback.
      const message = String(error?.message ?? ''), uiMessage = message ? uiLocale.displayMessage(error?.uiMessage) : uiError('error.main.operationIncomplete').uiMessage;
      return { duty: { state: 'not-sent', error: { message: message || uiError('error.main.operationIncomplete').message, ...(uiMessage ? { uiMessage } : {}) } }, ...(standingLost ? { standingLost } : {}) };
    }
  });
  // The person's permission to organize (steward-standing.cjs): the person in their window, or the designated butler
  // through NAW (stewardCaller; R234, the person, 2026-11-25: 「这个应该大管家自己可以点」), only as a step of its record.
  // No argument only says how it stands. The person's off is not the butler's to undo.
  register('stewardStanding', async (c, ...args) => {
    const [on] = args, refuse = (key, reason) => c.background ? new background.HandlerRefused(uiError(key), reason) : uiError(key);
    if (c.background ? !(await stewardCaller(c)) : !isCurrentHumanContext(c)) throw refuse('error.steward.standingOnly', 'standing-caller');
    if (args.length > 1 || on !== undefined && typeof on !== 'boolean') throw refuse('error.steward.standingInvalid', 'standing-invalid');
    if (on === undefined) return stewardStanding.view();
    const told = async () => { try { recordsChanged(true); await broadcastRoom(); } catch { /* Already switched; seen at the next change. */ } };
    // Whether it was switched is not known: the windows look again, and nobody is told that nothing changed.
    const unknown = async error => { if (error?.code !== 'STEWARD_STANDING_UNKNOWN') return; await told(); throw uiError('error.steward.standingUnknown'); };
    let value;
    if (!c.background) {
      try { value = stewardStanding.set(c, on); } catch (error) { await unknown(error); throw error; }
      // A line that cannot be written does not keep the person's switch from working.
      try { stewardRecord?.standingSwitch(on); } catch { /* The record shows that a line could not be written. */ }
    } else {
      const actor = backgroundOperation.current();
      if (!stewardRecord?.recording(actor)) throw refuse('error.steward.recordUnavailable', 'standing-unrecorded');
      try { value = stewardStanding.setByButler(actor, on); }
      catch (error) {
        await unknown(error);
        throw error?.code === 'STEWARD_STANDING_PERSON_OFF' ? refuse('error.steward.standingPersonOff', 'standing-person-off') : refuse('error.steward.standingUnavailable', 'standing-unchanged');
      }
      stewardRecord.did(actor, value.changed ? 'switched' : 'already');
      if (!value.changed) return value;
    }
    await told();
    return value;
  });
  // Patrol while idle (steward-wake.cjs patrol): the same two callers as the wake switch
  // (stewardWake below), which it needs on. null, 15, 30 or 60 minutes; no argument only says how it stands.
  register('stewardPatrol', async (c, ...args) => {
    if (c.background ? !(await stewardCaller(c)) : !isCurrentHumanContext(c)) throw uiError('error.steward.wakeOnly');
    if (args.length > 1 || args.length === 1 && ![null, 15, 30, 60].includes(args[0])) throw uiError('error.steward.patrolInvalid');
    if (!stewardWake) throw uiError('error.steward.wakeUnavailable');
    try { return args.length === 0 ? stewardWake.view({ held: c.background === true }) : stewardWake.setPatrol(args[0]); }
    catch (error) { throw uiError(error?.code === 'STEWARD_PATROL_WAKE_OFF' ? 'error.steward.patrolWakeOff' : error?.code === 'STEWARD_PATROL_INVALID' ? 'error.steward.patrolInvalid' : 'error.steward.wakeUnavailable'); }
  });
  // What the butler reads to report to the person only what is new (the person, 2026-11-09: 「我希望 NAW 自己可以监控
  // 自己的 agent，并通过自带的 agent（aka 大管家）来进行汇报」): the business events NAW already records without a
  // model (deliveries, decisions, failures, blocked steps, a space whose queue ran empty), after the position its last
  // read returned (butler-ledger.cjs eventsAfter). Only the designated butler, usable and in no space (stewardCaller);
  // the step is in its record like its other calls. It only reads.
  register('stewardEvents', async (c, position = null) => {
    if (!(await stewardCaller(c))) throw uiError('error.steward.eventsButlerOnly');
    try { return butlerIngress.ledger.eventsAfter(position); }
    catch (error) { throw uiError(error?.code === 'BUTLER_POSITION_STALE' ? 'error.steward.eventsPosition' : 'error.steward.eventsUnavailable'); }
  });
  // The switch for waking the butler when NAW has recorded something new (steward-wake.cjs; decided on the task board by
  // the butler then designated, 2026-11-13 01:20:41: 「事件来时唤醒大管家，我定了：做，默认关」, 「开关只给用户和大管家」):
  // the person in their window, or the designated butler through NAW (stewardCaller), whose step is in its record.
  // true or false turns it on or off; no argument only says how it stands.
  register('stewardWake', async (c, on) => {
    if (c.background ? !(await stewardCaller(c)) : !isCurrentHumanContext(c)) throw uiError('error.steward.wakeOnly');
    if (on !== undefined && typeof on !== 'boolean') throw uiError('error.steward.wakeInvalid');
    if (!stewardWake) throw uiError('error.steward.wakeUnavailable');
    // The person turning it off in their window is a line of 「大管家的记录」 (the butler's own calls are steps there).
    // Written after the switch is off: a line that cannot be written does not keep wakes on.
    let wasOn = false; try { wasOn = !c.background && on === false && stewardWake.view().on; } catch { wasOn = false; }
    let state;
    try { state = on === undefined ? stewardWake.view({ held: c.background === true }) : stewardWake.set(on); }
    catch (error) { throw uiError(error?.code === 'STEWARD_WAKE_NO_BUTLER' ? 'error.steward.wakeNoButler' : 'error.steward.wakeUnavailable'); }
    if (wasOn && !state.on) try { stewardRecord?.wakeOff(); } catch { /* The record shows that a line could not be written. */ }
    // The butler's own read also lists the open migration quiet windows and what waits behind each; null: not known.
    if (c.background && on === undefined) {
      let open = null; try { open = quietWindows ? quietWindows.holding([roomState.value, ...roomState.spaces.rooms], roomState.queueWaits) : null; } catch { open = null; }
      state = { ...state, quietWindows: open };
    }
    return state;
  });
  // B6: the person's own actions on an integration handoff: retry one delivery or everything
  // under one reason, say that a waiting handoff is dealt with (with or without a retry), answer
  // a question, and look at where things stand. Each is the person's alone. The background gate
  // is a fixed table that does not know this method, so an agent's call is refused here.
  register('handoff', async (c, action, value, choice) => {
    if (c.background) throw uiError('error.handoff.personOnly');
    const handoffs = integrationHandoffs;
    if (!handoffs) {
      // No engine. Either the switch is closed, or the engine could not be built: then the person
      // is shown why when they look, and no action can be done.
      const fault = queueDispatcher?.integrationError;
      if (!fault) throw uiError('error.handoff.unavailable');
      if (action === 'list' || action === 'space') return { started: false, engineFault: { ...fault } };
      throw uiError('error.handoff.notStarted');
    }
    let result;
    try {
      if (action === 'list') return handoffOverview(handoffs);
      // One space's view for its queue panel: the overview, and where each delivery of that space stands by queue item.
      if (action === 'space') {
        if (typeof value !== 'string' || !validRoomId(value)) throw uiError('error.handoff.invalid');
        const items = handoffs.spaceView(value);
        for (const item of Object.values(items)) if (item.state === 'held') item.why = require('./integrator-words.cjs').rowWords(item);
        return { ...handoffOverview(handoffs), items };
      }
      if (action === 'repository') return integrationRepository.show();
      if (action === 'setRepository') result = await integrationRepository.choose(value);
      else if (action === 'chooseRepository') {
        // The folder is picked in the system's own dialog, so the page names no path.
        const picked = await chooseRepositoryFolder(c);
        if (picked.canceled || typeof picked.filePaths?.[0] !== 'string') return { canceled: true };
        result = await integrationRepository.choose(picked.filePaths[0]);
      }
      else if (action === 'retryDelivery') result = handoffs.retryReady(value);
      // "Not needed": a delivery on hold, or one that was returned and not given back, is set aside for good.
      else if (action === 'drop') result = handoffs.drop(value);
      else if (action === 'retryReason') result = handoffs.retryReason(value);
      else if (action === 'resolve') result = handoffs.resolveHandoff(value, { retry: choice === true });
      else if (action === 'answer') result = handoffs.answer(value);
      else if (action === 'recheck' || action === 'confirm') {
        // A delivery held with the merge that was reported for it: checked again (git could not be read), or confirmed
        // by the person (the merge was made before the handoff began). Two steps: each is refused for a delivery held
        // the other way. While git does not answer nothing changes, and the person is told that.
        const engine = queueDispatcher?.integration;
        if (!engine) throw uiError('error.handoff.notStarted');
        const checked = action === 'confirm' ? await engine.confirm(value) : await engine.recheck(value);
        // (Said differently when the folder was read but git did not answer about the merge: then the folder is not the trouble.)
        if (checked.outcome === 'unanswered') throw uiError(checked.head === true ? 'error.handoff.recheckSilent' : 'error.handoff.recheckUnanswered');
        result = { outcome: checked.outcome };
      }
      else if (action === 'redo') {
        // A returned delivery: its task goes back into the space's queue with the integrator's reason, for the member
        // who did it if that member can still take it, and the delivery is marked so that it is not offered again.
        // Everything after the sessions were read is one step, so two presses cannot add the task twice.
        const sessions = roomState.apply(await c.client.call('initial')).sessions;
        const target = handoffs.redoTarget(value);
        const member = target.memberId ? sessions.find(session => session.id === target.memberId) : null;
        let assignee = null;
        try { if (member && !member.archived && member.state !== 'ended' && roomIds(member).includes(target.roomId)) assignee = member.id; } catch { /* Membership that cannot be read: any member may take it. */ }
        // The task as it was written while the queue still has it; the delivery's short label otherwise.
        const original = roomState.queueItems(target.roomId).find(item => item.id === target.itemId)?.text || target.text || target.branch;
        const words = text => displayText(target.note ? 'queue.redo.text' : 'queue.redo.plain', { text, branch: target.branch, note: target.note });
        const room = queueRules.ITEM_TEXT_LIMIT - words('').length;
        const task = original.length > room ? original.slice(0, room - 1).replace(/[\ud800-\udbff]$/, '') + '…' : original;
        const itemId = roomState.queueAdd(words(task), assignee, target.roomId, { kind: 'person', name: 'You', sessionId: null });
        try { result = { ...handoffs.markRedone(value), itemId, assignee }; }
        catch (error) {
          // The mark could not be kept: the task is taken out again, so that a second press does not add it twice.
          let stayed = false;
          try { roomState.queueCancel(itemId, target.roomId); } catch { stayed = true; }
          // The space's record has changed either way, so the windows are told.
          try { await broadcastRoom(); } catch { /* The next announcement carries it. */ }
          if (!stayed) throw error;
          // It could not be taken out either: the person is told that the task is in the queue, so that they do not press again.
          if (error?.code === 'HANDOFF_STATE') integrationFault = { message: String(error.message).slice(0, 300), at: Date.now() };
          throw uiError('error.handoff.redoKept');
        }
      }
      else throw uiError('error.handoff.invalid');
    } catch (error) {
      // The record refuses an action that does not fit its state (a handoff already dealt with,
      // a delivery that is no longer held): the person is told it cannot be done now. Any other
      // refusal of the record is a fault of the record (it could not be saved or read, or it
      // would have become invalid): it is said as that, and its message is kept.
      if (error?.code === 'HANDOFF_STATE' && error.stale === true) throw uiError('error.handoff.invalid');
      if (error?.code === 'HANDOFF_STATE') {
        integrationFault = { message: String(error.message).slice(0, 300), at: Date.now() };
        throw uiError('error.handoff.record');
      }
      throw error;
    }
    await broadcastRoom();
    queueDispatcher?.schedule();
    return result;
  });
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
  register('uiReady', c => { c.ready?.(); c.uiReady = true; c.armStatePush?.(); flushReveal(); });
  // Asked once by a window as it starts: is this the first window of this start of the app? Only that window
  // lands on the butler's conversation; a reload, a second window or an agent's view is answered no.
  register('landing', c => { if (c.background || landingOwner === null || c.view?.owner !== landingOwner) return false; landingOwner = null; return true; });
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
  register('modelChoices', (c, id) => modelChanges().choices(id));
  register('changeModel', async (c, id, value, nativeId) => {
    if (!c.background) return modelChanges().request(id, value, nativeId);
    // An agent names no native session: the card the person confirmed is bound to the one there is.
    try {
      const result = await modelChanges().request(id, value, c.client.snapshot().sessions.find(s => s.id === id)?.nativeId);
      if (result.status === 'pending') notifyModelChange({ sessionId: id, model: value.model, effort: value.effort, waiting: result.waiting || 'applying' });
      return result;
    } catch (error) {
      // Refused before anything was done: the person who confirmed it is told, and the agent gets the reason.
      const key = error?.uiMessage?.key;
      if (!key?.startsWith('error.modelChange.') || require('./session-model.cjs').UNSURE_KEYS.includes(key)) throw error;
      notifyModelChange({ sessionId: id, model: value?.model ?? null, effort: value?.effort ?? null, error: error.message, errorUiMessage: error.uiMessage });
      return { status: 'refused', reason: error.message };
    }
  });
  register('cancelModelChange', (c, id) => modelChanges().cancel(id));
  applicationHandlers.delete('cancelModelChange');
  register('interfaceSettings', (_c, ...args) => dsh.settings(...args));
  register('runtimeLocation', async (c, key, reset = false) => {
    if (!['claude', 'codex', 'python3'].includes(key) || typeof reset !== 'boolean') throw uiError("error.main.unknownProgramSetting");
    if (reset) setLocation(process.env.NAW_RUNTIME_CONFIG, key, null);
    else {
      const result = await showDialog(c, 'open', { title: displayText('os.chooseProgram'), buttonLabel: displayText('os.useProgram'), properties: ['openFile', 'showHiddenFiles'] });
      if (!result.canceled && result.filePaths.length === 1) setLocation(process.env.NAW_RUNTIME_CONFIG, key, result.filePaths[0]);
    }
    // The backends resolve their programs again, so the notice about a program the active backend cannot
    // run appears or goes with this change, not at the next session start.
    try { pushState(c, displayState(await c.client.refresh(), c)); } catch { /* the setting is saved; the next state shows it */ }
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
    const client = await connect(dataDir, c.view.owner, { page: !c.background }), old = c.client;
    c.client = client; bindClient(c); old.close(); await c.win.reload();
  });
  register('discoveries', (c, action, ...args) => {
    if (!isCurrentHumanContext(c)) throw uiError('error.discoveries.personOnly');
    if (action === 'status' && !args.length) return discoveries.prefill([roomState.value, ...roomState.spaces.rooms]);
    if (action === 'configure' && args.length === 1) return discoveries.configure(args[0]);
    if (action === 'mark' && args.length === 3) return discoveries.mark(...args);
    throw uiError('error.discoveries.invalid');
  });
  register('connectionUpdates', async c => {
    await c.client.refresh();
    return connectionUpdateOptions(c.client, app.getVersion(), roomState);
  });
  register('backendSwitchSettings', async (c, auto, migrate) => {
    let settings = backendSwitch.readSettings(dataDir);
    if (typeof auto === 'boolean' || typeof migrate === 'boolean') {
      let nextAuto = settings.auto;
      if (typeof auto === 'boolean') {
        nextAuto = auto;
      }
      settings = backendSwitch.writeSettings(dataDir, nextAuto, migrate);
    }
    // A record not belonging to a move in progress names sessions a move ended, including after a quit
    // mid-move; a record whose sessions all run again is cleared.
    await c.client.refresh(); const snapshot = c.client.snapshot(), live = snapshot.sessions;
    for (const [key, record] of Object.entries(backendSwitch.readRecords(dataDir))) if (key !== backendSwitching && !record.sessions.some(value => notReconnected(live, value))) backendSwitch.clearRecord(dataDir, key);
    switchRecords = backendSwitch.readRecords(dataDir);
    return { auto: settings.auto, migrate: settings.migrate, interrupted: endedByMove(roomState.apply(snapshot).sessions).map(value => value.name) };
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
    return runConnectionContinuation(c, id, { target, guard, nativeId, version, expected });
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
  // Pages the person declared in local-pages.json open in their own window, or as a tab of
  // the asking window; only their partitions are configured, never the main window's session above.
  const currentLocalPages = () => localPages ||= createLocalPages({
    dataDir, BrowserWindow, WebContentsView, session, shell, screen, uiError, displayText,
    windowDefaults: { show: false, focusable: !backgroundTest }, backgroundThrottling: !backgroundTest,
    present: win => { if (backgroundTest) { if (visibleTest) win.showInactive(); return; } if (win.isMinimized()) win.restore(); win.show(); win.focus(); },
    notify: (c, state) => sendToPage(c, 'workspace:local-page-tabs', state),
  });
  register('openLocalPage', (c, id, requested) => currentLocalPages().open(id, requested, { background: c.background, owner: c }));
  register('localPageTabs', (c, action, value) => {
    if (c.background) throw uiError('error.localPage.background');
    const pages = currentLocalPages();
    if (action === 'list') return pages.tabs(c);
    if (action === 'show') return pages.show(c, value);
    if (action === 'reload') return pages.reload(c, value);
    if (action === 'layout') return pages.layout(c, value);
    throw uiError('error.localPage.unknown', { id: '' });
  });
  applicationHandlers.delete('localPageTabs');
  register('textPath', (c, action, value) => {
    if (!isCurrentHumanContext(c)) throw uiError('error.paths.personOnly');
    if (action === 'inspect') return inspectTextPaths(value);
    if (action === 'open') return openTextPath(value, { openPath: target => shell.openPath(target), reveal: target => shell.showItemInFolder(target), isCurrent: () => isCurrentHumanContext(c) });
    throw uiError('error.files.localPathInvalid');
  });
  applicationHandlers.delete('textPath');
  register('openExternal', (c, href) => { const url = new URL(href); if (!['http:', 'https:'].includes(url.protocol)) throw uiError("error.main.unsupportedLinkType"); return c.background ? { url: url.href } : shell.openExternal(url.href); });
  register('openMessageFile', (c, source, file, options) => openMessageFile({
    snapshot: async () => roomState.apply(await c.client.call('initial')),
    openPath: target => shell.openPath(target),
    background: c.background,
    isCurrent: () => !c.win.isDestroyed() && windows.get(c.win.webContents.id) === c,
  }, source, file, options));
  register('initial', async c => {
    const appBuild = await (applicationBuild ||= appBuildInfo(app, dataDir));
    const snapshot = await c.client.call('initial'), request = backgroundOperation.request();
    let read = null;
    if (c.background && request?.maintenanceApproved && request.args.method === 'initial') {
      const id = request.args.arguments[0], expected = request.guard?.sessions?.find(s => s.id === id), target = snapshot.sessions.find(s => s.id === id);
      if (!conversationReaderAllowed(request.actor) || c.view.selected !== id || !expected || !target || target.nativeId !== expected.nativeId) throw uiError('error.background.conversationChanged');
      read = { sessionId: id, nativeId: target.nativeId };
    }
    const display = displayState(snapshot, c, read, true);
    if (!c.background) notifyCapacity(display, c.win);
    const result = { ...display, viewState: c.view, appVersion: app.getVersion(), appBuild, localeWarning, preflight: preflight() };
    return c.background ? backgroundOperation.conversationSnapshot(result, c.actor, read, c.view.selected, conversationAccess(c.actor, snapshot)) : omitHidden(result, c.shown);
  });
  // The sessions whose messages the page shows. The reply holds the messages of the ones it did not have.
  register('shownSessions', (c, ids) => {
    if (c.background || !validShown(ids)) throw uiError("error.main.invalidViewState");
    const report = reportShown(c.shown, ids, () => displayState(c.client.snapshot(), c, null, true));
    c.shown = report.shown;
    return { messages: report.messages };
  });
  // Search reads every session's messages, which the page no longer holds (local-search.js, same rules).
  register('search', (c, query, options = {}) => {
    // An agent's background view reads only the conversations it was given (initial, conversationAccess).
    if (c.background) throw uiError('error.operator.desktopOnly');
    if (typeof query !== 'string' || query.length > 1000 || !options || typeof options !== 'object') throw uiError("error.main.searchTooLong");
    const display = displayState(c.client.snapshot(), c), spaceId = typeof options.spaceId === 'string' ? options.spaceId : 'shared';
    // As the page's projectSpace: the space it shows; a space gone meanwhile has no records to find.
    const room = (display.rooms || [display.room]).find(r => (r?.id || 'shared') === spaceId) || null;
    return searchRecords({ ...display, room }, query, { scope: options.scope, sessionId: options.sessionId, archived: Boolean(options.archived), limit: options.limit });
  });
  register('mobilePairing', (c, selection) => {
    if (!isCurrentHumanContext(c)) throw uiError('error.operator.desktopOnly');
    // The retained manual API must not bypass the new all-scope carrier check.
    if (selection && selection.all !== undefined) throw uiError('error.mobile.carrierUnavailable');
    return beginAppMobile(selection);
  });
  register('mobileRevoke', c => {
    if (!isCurrentHumanContext(c)) throw uiError('error.operator.desktopOnly');
    return revokeAppMobile();
  });
  applicationHandlers.delete('mobilePairing');
  applicationHandlers.delete('mobileRevoke');
  for (const [name, action] of Object.entries({ mobileDetect: detectAppMobile, mobileConnect: connectAppMobile,mobileResume:resumeAppMobile,mobileCancelSetup:cancelAppMobileSetup,mobileSetupStatus:appMobileSetupStatus })) {
    register(name, (c, value) => {
      if (!isCurrentHumanContext(c)) throw uiError('error.operator.desktopOnly');
      return action(c, value);
    });
    applicationHandlers.delete(name);
  }
  for (const [method, name] of Object.entries({ mobileApprovalStatus: 'approvalStatus', mobileApprovalBegin: 'approvalBegin', mobileApprovalConfirm: 'approvalConfirm', mobileApprovalEnable: 'approvalEnable', mobileApprovalRevoke: 'approvalRevoke' })) {
    register(method, (c, value) => {
      if (!isCurrentHumanContext(c)) throw uiError('error.operator.desktopOnly');
      return name === 'approvalStatus' ? appMobileApprovalStatus(value) : appMobileBroker()[name](value);
    });
    applicationHandlers.delete(method);
  }
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
    for (const key of ['spaceId', 'sidebarView', 'agentGrouping', 'sidebarCollapsedGroups', 'sidebarCollapsedFolders', 'columnTerminalHeights', 'roomViews', 'panorama', 'mobileEndpoint']) if (next[key] !== undefined) c.view[key] = structuredClone(next[key]);
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
  register('copy', (c, text) => { if (typeof text !== 'string' || text.length > 100000) throw uiError("error.main.invalidCopyContent"); if (c.background) { c.clipboardText = text; c.clipboardImage = null; c.clipboardRevision = randomUUID(); return; } return clipboard.writeText(text); });
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
    snapshot: async source => {
      if (c.background && source?.kind === 'session' && source.sessionId !== c.actor.id && !conversationReaderAllowed(c.actor)) throw uiError('error.background.secretaryConversation');
      if (source?.kind === 'space-draft') return null; // This view's own draft, not a published space record.
      const snapshot = roomState.apply(await c.client.call('initial'));
      if (c.background && ['room', 'space-message'].includes(source?.kind)) {
        const access = conversationAccess(c.actor, snapshot);
        if (access.secretary || !access.roomIds.includes(source.roomId || 'shared')) throw uiError('error.background.spaceContent');
      }
      return snapshot;
    },
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
  register('copyImage', (c, token) => imagesFor(c).copy(token, c.background ? { writeImage: image => { c.clipboardImage = image; c.clipboardText = ''; c.clipboardRevision = randomUUID(); } } : clipboard));
  register('releaseImage', (c, token) => c.imagePreviews?.release(token));
  updateApplicationMenu();
  }
  const restore = views.filter(v => v.active);
  // The one window of this start lands on the butler. When several windows are restored each was left on
  // purpose, perhaps on one session, so none of them lands and each is where it was.
  landingOwner = restore.length > 1 ? null : (restore[0] || views.at(-1))?.owner || null;
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
    await resumeAppMobileOnBoot();
    if (!backendSwitchTimer) { backendSwitchTimer = setInterval(() => autoBackendSwitch().catch(() => {}), (testRequested && Number(process.env.NAW_TEST_BACKEND_SWITCH_MS)) || 60000); backendSwitchTimer.unref?.(); }
  }
  catch (error) {
    pendingReveal = null;
    dsh?.stop();
    await backgroundControl?.close(); backgroundControl = null;
    for (const c of [...windows.values()]) { c.failed = true; c.client.close(); c.win.destroy(); }
    if (!quitting && (!startupWindow || startupWindow.isDestroyed())) {
      startupWindow = createWindow(); await startupWindow.loadFile(startupFile);
    }
    if (!quitting && startupWindow && !startupWindow.isDestroyed()) startupWindow.webContents.send('workspace:startup', { kind: 'failed', code: uiLocale.startupCode(error.code), title: displayText('startup.failed'), detail: startupMessage(error, displayLanguage()), retry: true, data: error.code === 'NAW_VIEW_RECORD' });
  } finally { starting = false; if (!quitting) updateApplicationMenu(); }
}
// The page handled the full-state snapshot with this sequence; see pushState.
ipcMain.handle('workspace:state-rendered', (event, sequence) => {
  const context = windows.get(event.sender.id);
  if (!context || event.senderFrame !== event.sender.mainFrame || !trusted(event.senderFrame.url)) {
    return;
  }
  context.statePush?.acknowledged(sequence);
});
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
if (primary) app.whenReady().then(() => { notificationScreen ||= new (require('./confirmation-notifications.cjs').NotificationScreen)(powerMonitor); });
if (primary) app.whenReady().then(() => powerMonitor.on('resume', wakeAppMobileResume));
if (primary) app.whenReady().then(start);
app.on('window-all-closed', () => {});
app.on('before-quit', event => {
  if (tempReminders?.busy) {
    event.preventDefault();
    if (!tempQuitWaiting) { tempQuitWaiting = true; tempReminders.finished.finally(() => { tempQuitWaiting = false; app.quit(); }); }
    return;
  }
  pendingReveal = null;
  if (outboxClosing || butlerClosing) { event.preventDefault(); return; }
  if (quitting) return;
  try {
    if (viewStore?.loaded) {
      for (const { win, view } of windows.values()) if (!win.isDestroyed()) view.bounds = win.getBounds();
      saveViews();
    }
  } catch { event.preventDefault(); return; }
  // Sealing is synchronous and does no I/O, even if no butler is running.
  const driver = butlerBackend?.driver;
  driver?.beginShutdown();
  // Stop live authorization before asynchronously sealing the recovery mirror.
  if(mobileQuitWaiting){event.preventDefault();return;}
  suspendAppMobile();
  if(!mobileQuitSettled&&mobileBroker?.settlePersistence){
    event.preventDefault();mobileQuitWaiting=true;
    mobileBroker.settlePersistence(true).catch(()=>appMobileLog('quit','unconfirmed',0)).finally(()=>{mobileQuitWaiting=false;mobileQuitSettled=true;app.quit();});return;
  }
  // The NAW-owned butler belongs to this desktop, unlike ordinary native sessions.
  if (!butlerQuitAttempted && driver && (driver.child || driver.starting)) {
    event.preventDefault(); butlerClosing = true; butlerQuitAttempted = true; butlerBackend.confirmed = null;
    notifyButlerQuit('os.butlerQuitWaiting');
    let settled = false;
    const finish = confirmed => {
      if (settled) return; settled = true;
      clearTimeout(deadline); butlerClosing = false;
      if (!confirmed) notifyButlerQuit('os.butlerQuitUnconfirmed');
      setImmediate(() => app.quit());
    };
    const deadline = setTimeout(() => finish(false), 5000); deadline.unref();
    Promise.resolve().then(() => driver.close()).then(receipt => {
      finish(receipt?.stopped === true && receipt?.cleanupConfirmed !== false);
    }, () => finish(false));
    return;
  }
  if (outboxQuitFailed) { quitting = true; dsh?.stop(); return; }
  if (outboxBroker) {
    event.preventDefault();
    outboxClosing = true;
    Promise.resolve().then(() => Promise.all([outboxBroker.close(), backgroundControl?.close()])).then(() => {
      outboxClosing = false; quitting = true; dsh?.stop(); setImmediate(() => app.quit());
    }, () => {
      outboxClosing = false; outboxUnavailable = true; outboxQuitFailed = true;
      for (const context of windows.values()) {
        try { pushState(context, displayState(context.client.snapshot(), context)); } catch {}
      }
    });
  } else { quitting = true; dsh?.stop(); }
});
// Deliberately no native shutdown here: GUI lifecycle is independent of sessions.
app.on('will-quit', () => {
  // First: whatever fails below, this run ended on its own path.
  try { runMark?.exitClean(); } catch { /* The next start says it did not end normally. */ }
  discoveries?.dispose();
  backgroundNotifications?.dispose();
  notificationScreen?.dispose();
  queueDispatcher?.close();
  sessionModelChanges?.close();
  try { butlerIngress?.ledger.closeQuestionMetricEpoch(); } catch { /* An unclosed epoch remains unverified. */ }
});
function notifyButlerQuit(key) {
  // An in-window toast works when OS notices are disabled; OS delivery can outlive quit.
  for (const context of windows.values()) {
    if (!context.background) { try { sendToPage(context, 'workspace:quit-status', key); } catch {} }
  }
  try {
    if (Notification.isSupported()) new Notification({ title: displayText('os.butlerQuitTitle'), body: displayText(key) }).show();
  } catch { /* The in-window message remains available until exit. */ }
}
// A session rotation is announced to the person; the space record and log keep the ids.
function notifyRotation(outcome, record) {
  const keys = { done: 'os.rotationDoneBody', saved: 'os.rotationSavedBody', kept: 'os.rotationKeptBody', keptUnsaved: 'os.rotationKeptUnsavedBody', failed: 'os.rotationFailedBody', needsTrust: 'os.rotationNeedsTrustBody', trustTimedOut: 'os.rotationTrustTimedOutBody', trustTimeoutUnconfirmed: 'os.rotationTrustTimeoutUnconfirmedBody', trustCleanupUnconfirmed: 'os.rotationTrustCleanupUnconfirmedBody', trustStateInvalid: 'os.rotationTrustStateInvalidBody', trustStateUnknown: 'os.rotationTrustStateUnknownBody' };
  // The reason in the person's language, never its code (queueRules.rotationCauseKey; the 11-14 drill).
  const cause = queueRules.rotationCause(record);
  const notice = { key: keys[outcome], params: outcome === 'trustStateUnknown' ? {} : { old: record.name, new: record.newName || record.name, reason: cause ? displayText(cause.uiMessage.key, cause.uiMessage.params) : record.reason } };
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
// An automatic move that did not finish goes to the same log. Sessions this attempt left stopped are
// named there and in an OS notice, since only the person's click continues them.
function recordMigrationFailure(option, screens, error, startedAt) {
  const stops = option.switch.stops || [];
  const record = backendSwitch.readRecords(dataDir)[option.backendKey];
  let stopped = [];
  if (record && record.phase === 'stopped' && record.failedAt >= startedAt) {
    stopped = record.sessions.map(value => ({ id: value.id, nativeId: value.nativeId || null, name: value.name }));
  }
  const failed = (error && error.uiMessage && error.uiMessage.key) || 'unknown';
  const entry = { time: Date.now(), backend: option.backendKey, sessions: stops.map(stop => ({ id: stop.id, nativeId: stop.nativeId || null, name: stop.name })), screens, failed, stopped };
  try {
    fs.appendFileSync(path.join(dataDir, 'backend-migrations.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch {
    // The notice still goes out when the private log cannot be written.
  }
  if (!stopped.length) {
    return;
  }
  try {
    if (!Notification.isSupported()) {
      return;
    }
    const names = stopped.map(value => value.name).join('、');
    const notification = new Notification({ title: displayText('os.migrationTitle'), body: displayText('os.migrationStoppedBody', { names }) });
    notification.once('click', () => focusOrOpen());
    notification.show();
  } catch {
    // The private log remains when OS delivery fails.
  }
}
// Migrations NAW made without a click: an append-only private log and an OS notice.
function recordMigration(option, screens, result) {
  const stops = option.switch.stops || [];
  const left = (result && result.left) || [];
  const partial = left.length > 0 || Boolean(result && result.reconnectFailed);
  const confirmedByState = (result && result.confirmedByState) || [];
  const unprovenReason = option.switch.reason || '';
  const entry = { time: Date.now(), backend: option.backendKey, sessions: stops.map(stop => ({ id: stop.id, nativeId: stop.nativeId || null, name: stop.name })), screens, left: left.length, reconnectFailed: Boolean(result && result.reconnectFailed), confirmedByState, unproven: unprovenReason };
  try {
    fs.appendFileSync(path.join(dataDir, 'backend-migrations.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch {
    // The notice still goes out when the private log cannot be written.
  }
  if (!stops.length) {
    return;
  }
  const migrationNotice = { key: 'os.migrationBody', params: { names: stops.map(stop => stop.name).join('、') } };
  if (screens.length) {
    migrationNotice.key = 'os.migrationSavedBody';
  }
  if (partial) {
    migrationNotice.key = 'os.migrationPartialBody';
  }
  try {
    if (!Notification.isSupported()) {
      return;
    }
    const notification = new Notification({ title: displayText('os.migrationTitle'), body: displayText(migrationNotice.key, migrationNotice.params) });
    notification.once('click', () => focusOrOpen());
    notification.show();
  } catch {
    // The private log remains when OS delivery fails.
  }
}
// B6: the engine that hands delivered work to the person's designated integrator, for one
// dispatcher. It sends through the dispatcher's own send (the same backend entry, the same check
// right before sending and the same "not sent" rules as a queue item; whether the integrator
// can take a message is the handoff record's to judge), writes space records through the space state, and reads git
// only in the repository the designated integrator works in, whose main branch is "main".
function integrationEngine(dispatcher) {
  // Loaded here, not at the top: with the switch closed the daily app does not even read these files.
  const { IntegrationHandoffs } = require('./integrator-handoff.cjs');
  const { IntegratorEngine } = require('./integrator-engine.cjs');
  const integratorGit = require('./integrator-git.cjs');
  const { IntegrationRepository } = require('./integrator-repository.cjs');
  const handoffs = new IntegrationHandoffs(dataDir), repository = new IntegrationRepository(dataDir), readers = new Map();
  // git is read only in the main repository the person chose, and that folder is checked again
  // before every use. The working folder of the integrator's session is never read.
  const reader = () => {
    try {
      const folder = repository.usable();
      if (!folder) return null;
      if (!readers.has(folder)) { readers.clear(); readers.set(folder, integratorGit.reader(folder)); }
      return readers.get(folder);
    } catch { return null; }
  };
  // One checked look for a whole settlement: every question of it goes to the same folder.
  const open = () => { const read = reader(); return read ? { mainHead: () => read.branch('main'), reader: { commit: read.commit, isAncestor: read.isAncestor, changes: read.changes } } : null; };
  // A question git cannot be asked just now (no repository chosen, or it fails its checks) is answered "unknown".
  const ask = name => async (...args) => { const read = reader(); return read ? read[name](...args) : null; };
  // The engine keeps no timer: how long one of its passes waits for an answer from git is enforced here.
  const within = (answer, ms, late) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(late), ms);
    answer.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
  const engine = new IntegratorEngine({ handoffs, within, designation: () => integratorRole.current(), mainHead: () => ask('branch')('main'),
    reader: { commit: ask('commit'), isAncestor: ask('isAncestor'), changes: ask('changes') },
    send: (session, text, handoffId) => dispatcher.send(session, text, handoffId), typing: sessionId => dispatcher.noteHuman(sessionId),
    record: fact => roomState.recordHandoff(fact), notify: info => notifyHandoff(info),
    holderRecord: fact => roomState.recordHandoffHolder(fact), nameOf: session => dispatcher.name(session), holderLines: () => roomState.handoffHolderLines(),
    repository: () => (repository.usable() ? true : null), open });
  // The person's own entry gets the record only when the engine exists: an engine that could not
  // be built leaves the entry answering "not enabled" instead of changing a record nothing reads.
  integrationHandoffs = handoffs;
  integrationRepository = {
    // What the person is shown: the folder they chose, and why it cannot be read now, if so.
    show() {
      let root = null, problem = null;
      try { root = repository.chosen(); if (root !== null) repository.usable(); }
      catch (error) { problem = error?.uiMessage?.key || 'error.handoff.repositoryState'; }
      return { root, problem };
    },
    // The person's choice: null, and only null, clears it; a folder is checked and must have a main branch.
    async choose(selected) {
      if (selected === null) return { root: repository.set(null) };
      if (typeof selected !== 'string') throw uiError('error.handoff.repositoryUnsafe');
      const root = repository.check(selected);
      if (!(await integratorGit.reader(root).branch('main'))) throw uiError('error.handoff.repositoryNoMain');
      const chosen = repository.set(root);
      // The question about a missing repository is over (a later loss asks again), and what waited for it is tried at once.
      try { handoffs.reasonCleared('repository-chosen'); } catch { /* A record that cannot be changed now says so by itself. */ }
      engine.unblock();
      return { root: chosen };
    },
  };
  return engine;
}
// What the person is shown about integration handoffs: counts, what is on hold and why, the
// handoff that waits for them with its question, and the open questions. For the person only.
function handoffOverview(handoffs) {
  const snapshot = handoffs.snapshot(), open = snapshot.handoff;
  const brief = entry => ({ key: entry.key, roomId: entry.roomId, itemId: entry.itemId, branch: entry.branch, commit: entry.commit,
    ...(entry.text ? { text: entry.text } : {}), ...(entry.memberName ? { memberName: entry.memberName } : {}), ...(entry.note ? { note: entry.note } : {}) });
  // engineFault is the dispatcher's last fault of the engine's own step ({ message, at, count },
  // and recoveredAt when a later step went through): the person may have missed its one notice,
  // so it stays readable here.
  const engineFault = queueDispatcher?.integrationError;
  return { started: true, engineFault: engineFault ? { ...engineFault } : null, repository: integrationRepository ? integrationRepository.show() : null, summary: handoffs.summary(),
    held: handoffs.held().map(group => ({ reason: group.reason, count: group.count, entries: group.entries.map(brief) })),
    waiting: open && open.status === 'waiting' ? { handoffId: open.id, reason: open.reason, question: open.question || '', sessionId: open.integrator.sessionId,
      entries: snapshot.ready.filter(entry => open.keys.includes(entry.key)).map(brief) } : null,
    reasons: handoffs.openReasons(), unknownNotices: handoffs.unknownNotices(), fault: integrationFault && { ...integrationFault } };
}
// One notice for one reason of the integration handoff; without a reason, that its record
// cannot be read (null) or that the handoff step itself failed (undefined). It says how many
// deliveries, never their text. When the system cannot show a notice this throws: the engine
// then keeps the notice as "may not have been shown" and does not repeat it.
function notifyHandoff(info) {
  const words = info === null ? { title: 'os.handoffTitle', key: 'os.handoffUnreadable', params: {} }
    : info === undefined ? { title: 'os.handoffTitle', key: 'os.handoffFailed', params: {} } : require('./integrator-words.cjs').personWords(info);
  if (!words) return;
  if (!Notification.isSupported()) throw Error('Notifications are unavailable');
  const notification = new Notification({ title: displayText(words.title), body: displayText(words.key, words.params) });
  notification.once('click', () => focusOrOpen());
  notification.show();
}
// The system's folder dialog for the project folder where merges are checked (B6), opened for the person's window by the handoff entry.
function chooseRepositoryFolder(c) {
  return showDialog(c, 'open', { title: displayText('os.chooseRepository'), properties: ['openDirectory'] });
}
