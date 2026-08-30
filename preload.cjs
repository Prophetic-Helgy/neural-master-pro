/**
 * preload.cjs — contextBridge surface for the hardened renderer
 * (contextIsolation: true, nodeIntegration: false, sandbox: true).
 * The page gets exactly these four IPC calls and nothing Node-ish —
 * replacing the old `window.require('electron')` access from App.tsx.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nmpIpc', {
  getHardwareInfo: () => ipcRenderer.invoke('get-hardware-info'),
  getHardwareTemps: () => ipcRenderer.invoke('get-hardware-temps'),
  minimize: () => ipcRenderer.send('minimize-app'),
  close: () => ipcRenderer.send('close-app'),
});
