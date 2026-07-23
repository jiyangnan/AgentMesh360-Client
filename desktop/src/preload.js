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
  getProviderSnapshot: () => ipcRenderer.invoke('provider:get-snapshot'),
  createProviderProfile: ({ profile, apiKey }) => ipcRenderer.invoke('provider:create-profile', {
    profile,
    apiKey: String(apiKey || '').slice(0, 16_384),
  }),
  updateProviderProfile: ({ profileId, profile }) => ipcRenderer.invoke('provider:update-profile', {
    profileId: String(profileId || '').slice(0, 200),
    profile,
  }),
  replaceProviderSecret: ({ profileId, apiKey }) => ipcRenderer.invoke('provider:replace-secret', {
    profileId: String(profileId || '').slice(0, 200),
    apiKey: String(apiKey || '').slice(0, 16_384),
  }),
  deleteProviderProfile: (profileId) => ipcRenderer.invoke(
    'provider:delete-profile',
    String(profileId || '').slice(0, 200),
  ),
  upsertModelAssignment: (assignment) => ipcRenderer.invoke(
    'provider:upsert-assignment',
    assignment,
  ),
  deleteModelAssignment: (assignmentId) => ipcRenderer.invoke(
    'provider:delete-assignment',
    String(assignmentId || '').slice(0, 200),
  ),
  openSubscription: () => ipcRenderer.invoke('external:open-subscription'),
  openRegistration: () => ipcRenderer.invoke('external:open-registration'),
  onState: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('identity:state', handler);
    return () => ipcRenderer.removeListener('identity:state', handler);
  },
});
