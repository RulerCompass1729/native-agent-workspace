const { contextBridge, ipcRenderer } = require('electron');
const api = {};
for (const name of ['nativeHistory', 'importHistory', 'openLocalFile', 'closeLocalFile', 'saveLocalFile', 'prepareInput', 'observe', 'unobserve', 'continueConnection', 'archiveSession', 'restoreSession', 'archiveRoom', 'restoreRoom', 'retainDraftRecovery', 'discardDraftRecovery', 'readingState', 'runtimeLocation', 'retrySave']) {
  api[name] = async (...args) => { const result = await ipcRenderer.invoke(`workspace:${name}`, ...args); if (!result.ok) throw new Error(result.error); return result.value; };
}
for (const name of ['initial', 'uiReady', 'viewState', 'chooseFolder', 'create', 'rename', 'roomRename', 'roomNotes', 'join', 'claim', 'send', 'draft', 'terminal', 'terminalSnapshot', 'input', 'resize', 'interrupt', 'run', 'pause', 'forward', 'approve', 'stop', 'resume', 'forget', 'reconnect', 'preflight', 'dataDirectory', 'quitService', 'clearSharedHistory', 'newWindow', 'copy', 'pasteText', 'openExternal']) {
  api[name] = async (...args) => {
    const result = await ipcRenderer.invoke(`workspace:${name}`, ...args);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };
}
api.retryStartup = () => ipcRenderer.invoke('workspace:retry-startup');
api.startupData = () => ipcRenderer.invoke('workspace:startup-data');
for (const [name, channel] of [['onState', 'workspace:state'], ['onViewStorage', 'workspace:view-storage'], ['onReconnected', 'workspace:reconnected'], ['onSessionName', 'workspace:session-name'], ['onTerminal', 'workspace:terminal'], ['onProgress', 'workspace:progress'], ['onNew', 'workspace:new'], ['onDisconnected', 'workspace:disconnected'], ['onStartup', 'workspace:startup']]) {
  api[name] = callback => { const listener = (_event, data) => callback(data); ipcRenderer.on(channel, listener); return () => ipcRenderer.removeListener(channel, listener); };
}
contextBridge.exposeInMainWorld('workspace', Object.freeze(api));
