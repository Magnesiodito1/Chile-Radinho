const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  isApp: true,
  sources: () => ipcRenderer.invoke('sources'),
  choose: id => ipcRenderer.invoke('choose', id)
});
