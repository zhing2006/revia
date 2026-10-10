const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('reviaDesktop', {
  setLocale: locale => ipcRenderer.send('revia:locale', locale),
});
