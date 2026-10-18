const { contextBridge, ipcRenderer } = require('electron');
const api = {};
for (const name of ['initial', 'uiReady', 'viewState', 'chooseFolder', 'create', 'rename', 'join', 'claim', 'send', 'draft', 'terminal', 'terminalSnapshot', 'input', 'resize', 'interrupt', 'run', 'pause', 'forward', 'approve', 'stop', 'resume', 'forget', 'reconnect', 'preflight', 'dataDirectory', 'quitService', 'clearSharedHistory', 'newWindow', 'copy', 'pasteText', 'openExternal']) {
  api[name] = async (...args) => {
    const result = await ipcRenderer.invoke(`workspace:${name}`, ...args);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };
}
api.retryStartup = () => ipcRenderer.invoke('workspace:retry-startup');
for (const [name, channel] of [['onState', 'workspace:state'], ['onSessionName', 'workspace:session-name'], ['onTerminal', 'workspace:terminal'], ['onNew', 'workspace:new'], ['onDisconnected', 'workspace:disconnected'], ['onStartup', 'workspace:startup']]) {
  api[name] = callback => { const listener = (_event, data) => callback(data); ipcRenderer.on(channel, listener); return () => ipcRenderer.removeListener(channel, listener); };
}
contextBridge.exposeInMainWorld('workspace', Object.freeze(api));
