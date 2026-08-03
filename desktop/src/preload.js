'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

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
  getAgentManagementSnapshot: (agentId) => ipcRenderer.invoke(
    'agent:get-management-snapshot',
    String(agentId || '').slice(0, 100),
  ),
  getAgentModelOverview: () => ipcRenderer.invoke('agent:get-model-overview'),
  configureAndActivateAgent: ({ agentId, providerProfileId, modelId }) => ipcRenderer.invoke(
    'agent:configure-and-activate',
    {
      agentId: String(agentId || '').slice(0, 100),
      providerProfileId: String(providerProfileId || '').slice(0, 200),
      modelId: String(modelId || '').slice(0, 200),
    },
  ),
  saveAgentModel: ({ agentId, providerProfileId, modelId }) => ipcRenderer.invoke(
    'agent:save-model',
    {
      agentId: String(agentId || '').slice(0, 100),
      providerProfileId: String(providerProfileId || '').slice(0, 200),
      modelId: String(modelId || '').slice(0, 200),
    },
  ),
  saveAgentCustomization: ({
    agentId,
    kind,
    content,
    expectedRevision,
  }) => ipcRenderer.invoke('agent:save-customization', {
    agentId: String(agentId || '').slice(0, 100),
    kind: String(kind || '').slice(0, 20),
    // Keep valid 8,000-code-point text intact, including surrogate pairs.
    // Oversized input remains oversized so Main rejects it instead of saving
    // a silently truncated value.
    content: String(content ?? '').slice(0, 16_002),
    expectedRevision,
  }),
  clearAgentCustomization: ({ agentId, kind, expectedRevision }) => ipcRenderer.invoke(
    'agent:clear-customization',
    {
      agentId: String(agentId || '').slice(0, 100),
      kind: String(kind || '').slice(0, 20),
      expectedRevision,
    },
  ),
  getConversationSnapshot: () => ipcRenderer.invoke('conversation:get-snapshot'),
  openAgentConversation: (agentId) => ipcRenderer.invoke(
    'conversation:open',
    String(agentId || '').slice(0, 100),
  ),
  pickConversationAttachments: () => ipcRenderer.invoke('conversation:pick-attachments'),
  stageConversationFiles: async (files) => {
    const list = Array.from(files || []);
    if (list.length < 1 || list.length > 10) throw new Error('每次请选择 1 至 10 个文件');
    const paths = [];
    const items = [];
    for (const file of list) {
      const filePath = webUtils.getPathForFile(file);
      if (filePath) {
        paths.push(String(filePath).slice(0, 4_097));
        continue;
      }
      if (Number(file?.size) > 20 * 1024 * 1024) throw new Error('单个附件不能超过 20 MB');
      const bytes = new Uint8Array(await file.arrayBuffer());
      items.push({
        name: String(file?.name || 'clipboard-image.png').slice(0, 181),
        mimeType: String(file?.type || '').slice(0, 161),
        bytes,
      });
    }
    let state = null;
    if (paths.length) state = await ipcRenderer.invoke('conversation:stage-paths', paths);
    if (items.length) state = await ipcRenderer.invoke('conversation:stage-bytes', items);
    return state;
  },
  stageConversationLink: (url) => ipcRenderer.invoke(
    'conversation:stage-link',
    String(url || '').slice(0, 2_049),
  ),
  discardConversationAttachment: (attachmentId) => ipcRenderer.invoke(
    'conversation:discard-attachment',
    String(attachmentId || '').slice(0, 65),
  ),
  sendConversationMessage: (request) => ipcRenderer.invoke('conversation:send', {
    text: String(
      typeof request === 'string' ? request : request?.text || '',
    ).slice(0, 16_001),
    attachmentIds: Array.isArray(request?.attachmentIds)
      ? request.attachmentIds.slice(0, 11).map((value) => String(value || '').slice(0, 65))
      : [],
  }),
  interjectConversationMessage: (text) => ipcRenderer.invoke(
    'conversation:interject',
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
