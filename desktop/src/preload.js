'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentmesh360', {
  getState: () => ipcRenderer.invoke('identity:get-state'),
  login: ({ email, password }) => ipcRenderer.invoke('identity:login', {
    email: String(email || '').slice(0, 320),
    password: String(password || '').slice(0, 1024),
  }),
  oauthLogin: (provider) => ipcRenderer.invoke('identity:login', {
    provider: ['google', 'github'].includes(provider) ? provider : '',
  }),
  logout: () => ipcRenderer.invoke('identity:logout'),
  recheck: () => ipcRenderer.invoke('identity:recheck'),
  activateAgent: (agentId) => ipcRenderer.invoke('agent:activate', String(agentId || '').slice(0, 100)),
  getConversationSnapshot: () => ipcRenderer.invoke('conversation:get-snapshot'),
  openAgentConversation: (agentId) => ipcRenderer.invoke(
    'conversation:open',
    String(agentId || '').slice(0, 100),
  ),
  sendConversationMessage: (text) => ipcRenderer.invoke(
    'conversation:send',
    String(text || '').slice(0, 16_001),
  ),
  respondConversationPermission: (interactionId, optionId = null) => ipcRenderer.invoke(
    'conversation:respond-permission',
    String(interactionId || '').slice(0, 100),
    optionId === null ? null : String(optionId || '').slice(0, 100),
  ),
  closeAgentConversation: () => ipcRenderer.invoke('conversation:close'),
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
  runProviderProbe: ({
    profileId,
    modelId,
    level,
    confirmPaidInference = false,
  } = {}) => ipcRenderer.invoke('provider:run-probe', {
    profileId: String(profileId || '').slice(0, 200),
    modelId: String(modelId || '').slice(0, 200),
    level: String(level || '').slice(0, 40),
    confirmPaidInference: confirmPaidInference === true,
  }),
  testProviderConnection: ({
    profile,
    apiKey,
    modelId,
    confirmPaidInference = false,
  } = {}) => ipcRenderer.invoke('provider:test-connection', {
    profile,
    apiKey: String(apiKey || '').slice(0, 16_384),
    modelId: String(modelId || '').slice(0, 200),
    confirmPaidInference: confirmPaidInference === true,
  }),
  discoverProviderModels: ({ profile, apiKey } = {}) => ipcRenderer.invoke(
    'provider:discover-models',
    {
      profile,
      apiKey: String(apiKey || '').slice(0, 16_384),
    },
  ),
  getPackageSnapshot: () => ipcRenderer.invoke('package:get-snapshot'),
  refreshPackageRegistry: () => ipcRenderer.invoke('package:refresh-registry'),
  downloadAgentPackage: (packageId) => ipcRenderer.invoke(
    'package:download',
    String(packageId || '').slice(0, 128),
  ),
  approveAgentPackage: (approvalId) => ipcRenderer.invoke(
    'package:approve',
    String(approvalId || '').slice(0, 36),
  ),
  rollbackAgentPackage: (packageId) => ipcRenderer.invoke(
    'package:rollback',
    String(packageId || '').slice(0, 128),
  ),
  reconcileAgentPackage: (packageId) => ipcRenderer.invoke(
    'package:reconcile',
    String(packageId || '').slice(0, 128),
  ),
  getBackgroundSnapshot: () => ipcRenderer.invoke('runtime:get-background-snapshot'),
  setBackgroundStartup: (enabled) => ipcRenderer.invoke(
    'runtime:set-background-startup',
    enabled === true,
  ),
  openSubscription: () => ipcRenderer.invoke('external:open-subscription'),
  openRegistration: () => ipcRenderer.invoke('external:open-registration'),
  onState: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('identity:state', handler);
    return () => ipcRenderer.removeListener('identity:state', handler);
  },
  onConversationState: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('conversation:state', handler);
    return () => ipcRenderer.removeListener('conversation:state', handler);
  },
});
