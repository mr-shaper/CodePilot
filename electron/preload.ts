const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
  },
  setTitleBarTheme: (isDark: boolean) => ipcRenderer.send('set-titlebar-theme', isDark),
  openExternal: (url: string) => ipcRenderer.send('open-external', url),
  onOpenFolder: (callback: (path: string) => void) => {
    ipcRenderer.on('open-folder', (_, path) => callback(path));
  },
});
