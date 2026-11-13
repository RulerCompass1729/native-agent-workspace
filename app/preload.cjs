const { contextBridge, ipcRenderer } = require('electron');
// DSH waits for this optional bridge before mounting. Keep read entirely
// local, with a validated native-shell snapshot even if later IPC is offline.
const localePrefix = '--naw-ui-locale=';
const validLocale = value => value && typeof value === 'object' && Array.isArray(value.languages) && value.languages.every(item => typeof item === 'string') &&
  (value.preference === null || typeof value.preference === 'string' && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(value.preference));
const localeCopy = value => Object.freeze({ languages: Object.freeze([...value.languages]), preference: value.preference });
let localeSnapshot = localeCopy({ languages: [], preference: null }), startupLanguage;
try {
  const argument = process.argv.findLast(value => value.startsWith(localePrefix));
  const initial = JSON.parse(argument.slice(localePrefix.length));
  if (validLocale(initial)) { localeSnapshot = localeCopy(initial); if (['zh', 'en'].includes(initial.startupLanguage)) startupLanguage = initial.startupLanguage; }
} catch { /* No trustworthy shell snapshot: keep a valid English fallback. */ }
const nativeLocaleSnapshot = value => localeCopy({ languages: value.languages, preference: value.preference ?? (['zh', 'en'].includes(value.startupLanguage) ? value.startupLanguage : null) });
if (startupLanguage) localeSnapshot = nativeLocaleSnapshot({ ...localeSnapshot, startupLanguage });
ipcRenderer.on('workspace:locale', (_event, value) => { if (validLocale(value)) localeSnapshot = nativeLocaleSnapshot(value); });
contextBridge.exposeInMainWorld('__DSH_LOCALE__', Object.freeze({
  bootstrap: Object.freeze({ ...localeSnapshot, startupLanguage }),
  read: async () => localeSnapshot,
  // SDK calls this after optimistic presentation changes. It is not a Host
  // write receipt and cannot update native-shell preferences or trigger input.
  onChange() {},
}));
const api = {};
api.backgroundDecision = async (...args) => { const result = await ipcRenderer.invoke('workspace:backgroundDecision', ...args); if (!result.ok) throw apiFailure(result); return result.value; };
function apiFailure(result) {
  const message = result.error;
  // Sandboxed preload cannot load local helpers. Main already validates this
  // optional metadata; the renderer validates its known catalog again. Reject
  // a plain value: Electron strips all custom properties from Error instances.
  if (result.uiMessage?.version === 1 && typeof result.uiMessage.key === 'string' && result.uiMessage.key.startsWith('error.')) {
    return { name: 'Error', message, uiMessage: result.uiMessage };
  }
  return new Error(message);
}
api.createDefaults = async () => { const result = await ipcRenderer.invoke('workspace:createDefaults'); if (!result.ok) throw apiFailure(result); return result.value; };
api.gitWorktreePreview = async (...args) => { const result = await ipcRenderer.invoke('workspace:gitWorktreePreview', ...args); if (!result.ok) throw apiFailure(result); return result.value; };
api.butlerReview = async (...args) => { const result = await ipcRenderer.invoke('workspace:butlerReview', ...args); if (!result.ok) throw apiFailure(result); return result.value; };
api.butler = async (...args) => { const result = await ipcRenderer.invoke('workspace:butler', ...args); if (!result.ok) throw apiFailure(result); return result.value; };
api.records = async (...args) => { const result = await ipcRenderer.invoke('workspace:records', ...args); if (!result.ok) throw apiFailure(result); return result.value; };
for (const name of ['mobilePairing', 'mobileRevoke']) {
  api[name] = async (...args) => { const result = await ipcRenderer.invoke(`workspace:${name}`, ...args); if (!result.ok) throw apiFailure(result); return result.value; };
}
for (const name of ['queueSecretary', 'integrator', 'handoff', 'connectionUpdates', 'backendSwitchSettings', 'switchBackend', 'spaceMerge', 'spaceCreate', 'spaceAction', 'spaceFiles', 'roomMemberOrder', 'sidebar', 'stageImages', 'pasteNativeContent', 'nativeHistory', 'importHistory', 'openLocalFile', 'closeLocalFile', 'saveLocalFile', 'prepareInput', 'observe', 'unobserve', 'continueConnection', 'archiveSession', 'restoreSession', 'archiveRoom', 'restoreRoom', 'retainDraftRecovery', 'discardDraftRecovery', 'readingState', 'runtimeLocation', 'retrySave', 'steward', 'stewardRecord', 'landing']) {
  api[name] = async (...args) => { const result = await ipcRenderer.invoke(`workspace:${name}`, ...args); if (!result.ok) throw apiFailure(result); return result.value; };
}
for (const name of ['initial', 'uiReady', 'viewState', 'shownSessions', 'search', 'chooseFolder', 'create', 'rename', 'roomRename', 'roomNotes', 'join', 'claim', 'send', 'queue', 'queueShared', 'steerShared', 'steer', 'draft', 'terminal', 'terminalSnapshot', 'input', 'resize', 'interrupt', 'run', 'pause', 'wakePolicy', 'operatorAction', 'forward', 'approve', 'answer', 'stop', 'resume', 'forget', 'reconnect', 'preflight', 'dataDirectory', 'quitService', 'clearSharedHistory', 'newWindow', 'copy', 'pasteText', 'openExternal']) {
  api[name] = async (...args) => {
    const result = await ipcRenderer.invoke(`workspace:${name}`, ...args);
    if (!result.ok) throw apiFailure(result);
    return result.value;
  };
}
for (const name of ['previewImage', 'expandImage', 'copyImage', 'releaseImage', 'openMessageFile']) {
  api[name] = async (...args) => { const result = await ipcRenderer.invoke(`workspace:${name}`, ...args); if (!result.ok) throw apiFailure(result); return result.value; };
}
api.retryStartup = () => ipcRenderer.invoke('workspace:retry-startup');
api.startupData = () => ipcRenderer.invoke('workspace:startup-data');
// Full state arrives one snapshot at a time once this page is ready: the main process sends the next one
// only after this acknowledgement, so a slow page cannot pile up snapshots it has not handled. The listener
// is registered at load, so every numbered snapshot is acknowledged exactly once, also when no subscriber
// exists yet or one of them throws. Sequence 0 marks a snapshot that needs no reply.
const stateCallbacks = new Set();
ipcRenderer.on('workspace:state', (_event, value, sequence) => {
  let failure = null;
  try {
    for (const callback of [...stateCallbacks]) {
      try {
        callback(value);
      } catch (error) {
        failure = failure || error;
      }
    }
  } finally {
    if (sequence) {
      ipcRenderer.invoke('workspace:state-rendered', sequence).catch(() => {});
    }
  }
  if (failure) {
    throw failure;
  }
});
api.onState = callback => {
  stateCallbacks.add(callback);
  return () => stateCallbacks.delete(callback);
};
for (const [name, channel] of [['onQuitStatus', 'workspace:quit-status'], ['onRevealRecord', 'workspace:reveal-record'], ['onLocale', 'workspace:locale'], ['onViewStorage', 'workspace:view-storage'], ['onReconnected', 'workspace:reconnected'], ['onBackendSwitched', 'workspace:backend-switched'], ['onSessionName', 'workspace:session-name'], ['onTerminal', 'workspace:terminal'], ['onProgress', 'workspace:progress'], ['onNew', 'workspace:new'], ['onDisconnected', 'workspace:disconnected'], ['onStartup', 'workspace:startup'], ['onRecordsChanged', 'workspace:records-changed']]) {
  api[name] = callback => { const listener = (_event, ...data) => callback(...data); ipcRenderer.on(channel, listener); return () => ipcRenderer.removeListener(channel, listener); };
}
contextBridge.exposeInMainWorld('workspace', Object.freeze(api));
