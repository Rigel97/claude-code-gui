const { contextBridge, ipcRenderer } = require('electron');

const api = {
  openDirectory: () => ipcRenderer.invoke('dialog:open-directory'),

  store: {
    get: (key) => ipcRenderer.invoke('store:get', key),
    set: (key, value) => ipcRenderer.invoke('store:set', key, value),
  },

  claude: {
    send: (payload) => ipcRenderer.invoke('claude:send', payload),
    abort: () => ipcRenderer.invoke('claude:abort'),

    onStream: (callback) => {
      const handler = (_e, data) => callback(data);
      ipcRenderer.on('claude:stream', handler);
      return () => ipcRenderer.removeListener('claude:stream', handler);
    },

    onStatusChange: (callback) => {
      const handler = (_e, status) => callback(status);
      ipcRenderer.on('claude:status', handler);
      return () => ipcRenderer.removeListener('claude:status', handler);
    },
  },

  fs: {
    readDir: (dirPath) => ipcRenderer.invoke('fs:read-dir', dirPath),
  },

  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
  },
};

contextBridge.exposeInMainWorld('api', api);
