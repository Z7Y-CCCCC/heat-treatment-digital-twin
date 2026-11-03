const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('startupActivation', Object.freeze({
    status: () => ipcRenderer.invoke('startup:activation-status'),
    activate: code => ipcRenderer.invoke('startup:activate', code),
    copyFingerprint: () => ipcRenderer.invoke('startup:copy-fingerprint')
}));
