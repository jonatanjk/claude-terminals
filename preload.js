// Bridge from the UI page to the Electron main process: only the Dock/taskbar badge crosses it.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ctDesktop', {
  setBadge: (n, overlay) => ipcRenderer.send('ct-badge', +n || 0, typeof overlay === 'string' ? overlay : null),
});
