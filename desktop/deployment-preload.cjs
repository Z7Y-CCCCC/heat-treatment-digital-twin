const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('deployment', {
    load: () => ipcRenderer.invoke('deployment:load'),
    save: value => ipcRenderer.invoke('deployment:save', value),
    probe: value => ipcRenderer.invoke('deployment:probe', value)
});
