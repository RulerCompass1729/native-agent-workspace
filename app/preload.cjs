const { contextBridge, ipcRenderer } = require('electron');
const api = {};
for (const name of ['initial', 'viewState', 'chooseFolder', 'create', 'join', 'claim', 'send', 'draft', 'terminal', 'terminalSnapshot', 'input', 'resize', 'interrupt', 'run', 'pause', 'forward', 'approve', 'stop', 'newWindow', 'copy', 'openExternal']) {
  api[name] = async (...args) => {
    const result = await ipcRenderer.invoke(`workspace:${name}`, ...args);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };
}
for (const [name, channel] of [['onState', 'workspace:state'], ['onTerminal', 'workspace:terminal'], ['onNew', 'workspace:new'], ['onDisconnected', 'workspace:disconnected']]) {
  api[name] = callback => { const listener = (_event, data) => callback(data); ipcRenderer.on(channel, listener); return () => ipcRenderer.removeListener(channel, listener); };
}
contextBridge.exposeInMainWorld('workspace', Object.freeze(api));
