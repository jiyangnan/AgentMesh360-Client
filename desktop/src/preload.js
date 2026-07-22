'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentmesh360', {
  getState: () => ipcRenderer.invoke('identity:get-state'),
  login: ({ email, password }) => ipcRenderer.invoke('identity:login', {
    email: String(email || '').slice(0, 320),
    password: String(password || '').slice(0, 1024),
  }),
  logout: () => ipcRenderer.invoke('identity:logout'),
  recheck: () => ipcRenderer.invoke('identity:recheck'),
  activateAgent: (agentId) => ipcRenderer.invoke('agent:activate', String(agentId || '').slice(0, 100)),
  openSubscription: () => ipcRenderer.invoke('external:open-subscription'),
  openRegistration: () => ipcRenderer.invoke('external:open-registration'),
  onState: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('identity:state', handler);
    return () => ipcRenderer.removeListener('identity:state', handler);
  },
});
