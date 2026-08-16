'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktopWindow', Object.freeze({
  minimize: () => ipcRenderer.send('desktop:window-control', 'minimize'),
  toggleMaximize: () => ipcRenderer.send('desktop:window-control', 'toggle-maximize'),
  close: () => ipcRenderer.send('desktop:window-control', 'close'),
  getState: () => ipcRenderer.invoke('desktop:get-window-state'),
  getDashboardData: () => ipcRenderer.invoke('desktop:dashboard-data'),
  toggleDashboard: () => ipcRenderer.invoke('desktop:dashboard-toggle'),
  getDashboardState: () => ipcRenderer.invoke('desktop:dashboard-state'),
  onStateChange: callback => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('desktop:window-state', listener)
    return () => ipcRenderer.removeListener('desktop:window-state', listener)
  },
  onPageTitle: callback => {
    const listener = (_event, title) => callback(title)
    ipcRenderer.on('desktop:page-title', listener)
    return () => ipcRenderer.removeListener('desktop:page-title', listener)
  },
  onDashboardRefresh: callback => {
    const listener = (_event, sessionId) => callback(sessionId)
    ipcRenderer.on('desktop:dashboard-refresh', listener)
    return () => ipcRenderer.removeListener('desktop:dashboard-refresh', listener)
  },
}))
