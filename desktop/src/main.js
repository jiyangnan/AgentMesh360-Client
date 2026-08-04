'use strict';

const path = require('node:path');
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  powerMonitor,
  safeStorage,
  session,
  shell,
} = require('electron');
const { AgentMeshCoreClient } = require('./auth/core-client');
const { DesktopOAuthBroker } = require('./auth/oauth-loopback');
const { SecureTokenStore } = require('./auth/secure-token-store');
const { AcpHostClient } = require('./host/acp-client');
const { AgentConversationController } = require('./conversation-controller');
const { ConversationAttachmentStore } = require('./conversation-attachment-store');
const { DictationController } = require('./dictation-controller');
const { MacOSLocalDictationService } = require('./local-dictation-service');
const { PromptHistoryStore } = require('./prompt-history-store');
const { WorkspaceAuthorityStore } = require('./workspace-authority-store');
const { AgentManagementController } = require('./agent-management-controller');
const { IdentityController } = require('./identity-controller');
const { PackageController } = require('./package-controller');
const { ProviderController } = require('./provider-controller');
const { configureP5CanaryRuntime } = require('./canary-runtime');
const {
  LoginItemController,
  WindowLifecycle,
  activateAgentAndEnableBackground,
  publicBackgroundSnapshot,
  resolveStartupIntent,
} = require('./background-startup');

const SUBSCRIPTION_URL = 'https://agentmesh360.com/app/#pricing';
const REGISTRATION_URL = 'https://agentmesh360.com/app/#register';

let window = null;
let controller = null;
let conversations = null;
let conversationAttachments = null;
let conversationWorkspaces = null;
let conversationPromptHistory = null;
let dictations = null;
let localDictationService = null;
const canaryRuntime = configureP5CanaryRuntime({ app });
const loginItems = new LoginItemController({ app });
const startupIntent = resolveStartupIntent({
  argv: process.argv,
  loginItemSnapshot: loginItems.getSnapshot(),
});
const windows = new WindowLifecycle({
  background: startupIntent.background,
  createWindow: () => {
    window = createWindow();
    return window;
  },
  dock: app.dock,
});

if (!app.requestSingleInstanceLock(startupIntent.singleInstanceData)) {
  app.quit();
} else {
  app.on('second-instance', (_event, _commandLine, _workingDirectory, additionalData) => {
    windows.handleSecondInstance(additionalData);
  });

  app.whenReady().then(boot).catch(() => app.quit());
}

async function boot() {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.on('will-download', (event) => event.preventDefault());
  const core = new AgentMeshCoreClient();
  const oauth = new DesktopOAuthBroker({
    core,
    allowedCoreOrigin: new URL(core.baseUrl).origin,
    openExternal: (url) => shell.openExternal(url),
  });
  const tokenStore = new SecureTokenStore({
    safeStorage,
    filePath: path.join(app.getPath('userData'), 'identity', 'refresh-token.secure.json'),
  });
  const host = new AcpHostClient();
  conversationAttachments = new ConversationAttachmentStore({
    rootDir: path.join(app.getPath('userData'), 'conversation-drafts'),
  });
  await conversationAttachments.initialize();
  conversationWorkspaces = new WorkspaceAuthorityStore({
    rootDir: path.join(app.getPath('userData'), 'conversation-workspaces'),
    attachmentStore: conversationAttachments,
  });
  await conversationWorkspaces.initialize();
  conversationPromptHistory = new PromptHistoryStore({
    requestHistory: ({ params }) => host.getPromptHistory({
      cwd: params.cwd,
      sessionId: params.filter_session_id,
    }),
  });
  controller = new IdentityController({ core, tokenStore, host, oauth });
  conversations = new AgentConversationController({
    identity: controller,
    host,
    activateAgent: (agentId) => activateAgentAndEnableBackground({
      identity: controller,
      loginItems,
      agentId,
    }),
    attachmentStore: conversationAttachments,
    workspaceAuthorityStore: conversationWorkspaces,
    promptHistoryStore: conversationPromptHistory,
  });
  const packages = new PackageController({ identity: controller, host });
  const providers = new ProviderController({ identity: controller, host });
  const agentManagement = new AgentManagementController({ identity: controller, host });
  localDictationService = new MacOSLocalDictationService({ app });
  dictations = new DictationController({
    identity: controller,
    host: localDictationService,
  });

  registerIpc(
    controller,
    providers,
    packages,
    conversations,
    agentManagement,
    loginItems,
    host,
    dictations,
  );
  windows.onReady();
  controller.subscribe((state) => {
    if (!window?.isDestroyed()) window.webContents.send('identity:state', state);
  });
  conversations.subscribe((state) => {
    if (!window?.isDestroyed()) window.webContents.send('conversation:state', state);
    const active = dictations?.getSnapshot?.();
    if (
      ['starting', 'listening', 'transcribing'].includes(active?.phase)
      && active.agentId !== state?.agentId
    ) {
      cancelActiveLocalDictation();
    }
  });
  dictations.subscribe((state) => {
    if (!window?.isDestroyed()) window.webContents.send('dictation:state', state);
  });
  powerMonitor.on('resume', () => controller.revalidate('resume').catch(() => {}));
  const cancelDictationForSystemPause = () => {
    cancelActiveLocalDictation();
  };
  powerMonitor.on('suspend', cancelDictationForSystemPause);
  powerMonitor.on('lock-screen', cancelDictationForSystemPause);
  const initialState = await controller.start();
  if (
    startupIntent.background
    && initialState.phase === 'signed_out'
    && !windows.hasWindow()
  ) {
    app.quit();
    return;
  }

  app.on('activate', () => {
    windows.open();
  });
}

function createWindow() {
  const created = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#090d16',
    title: 'AgentMesh360',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: process.env.AGENTMESH360_ENABLE_DEVTOOLS === '1',
    },
  });
  created.removeMenu();
  created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  created.webContents.on('will-navigate', (event) => event.preventDefault());
  created.webContents.on('render-process-gone', () => cancelActiveLocalDictation());
  created.webContents.on('unresponsive', () => cancelActiveLocalDictation());
  created.on('focus', () => {
    if (!controller?.isRevalidationDue()) return;
    controller.revalidate('focus').catch(() => {});
  });
  created.once('ready-to-show', () => created.show());
  created.on('closed', () => {
    cancelActiveLocalDictation();
    if (window === created) window = null;
  });
  created.loadFile(path.join(__dirname, 'ui', 'index.html'));
  return created;
}

function registerIpc(
  identity,
  providers,
  packages,
  conversationController,
  agentManagement,
  loginItemController,
  host,
  dictationController = null,
) {
  ipcMain.handle('identity:get-state', () => identity.getState());
  ipcMain.handle('identity:login', (_event, credentials) => {
    const hasProvider = Object.hasOwn(credentials || {}, 'provider');
    const provider = typeof credentials?.provider === 'string'
      ? credentials.provider.toLowerCase()
      : '';
    if (hasProvider) {
      if (!['google', 'github'].includes(provider)) {
        throw new Error('第三方登录方式无效');
      }
      return identity.loginWithOAuth(provider);
    }
    const email = typeof credentials?.email === 'string' ? credentials.email : '';
    const password = typeof credentials?.password === 'string' ? credentials.password : '';
    return identity.login(email, password);
  });
  ipcMain.handle('identity:logout', () => identity.logout());
  ipcMain.handle('identity:recheck', () => identity.revalidate('manual'));
  ipcMain.handle('agent:get-management-snapshot', (_event, agentId) => {
    return agentManagement.getSnapshot(agentId);
  });
  ipcMain.handle('agent:get-model-overview', () => {
    return agentManagement.getOverview();
  });
  ipcMain.handle('agent:refresh-model-overview', async () => {
    await identity.refreshAgents();
    return agentManagement.getOverview();
  });
  ipcMain.handle(
    'agent:configure-and-activate',
    async (_event, { agentId, providerProfileId, modelId } = {}) => {
      await agentManagement.saveModel(agentId, providerProfileId, modelId);
      return activateAgentAndEnableBackground({
        identity,
        loginItems: loginItemController,
        agentId,
      });
    },
  );
  ipcMain.handle(
    'agent:save-model',
    (_event, { agentId, providerProfileId, modelId } = {}) => {
      return agentManagement.saveModel(agentId, providerProfileId, modelId);
    },
  );
  ipcMain.handle('agent:save-customization', (_event, request) => {
    return agentManagement.saveCustomization(request);
  });
  ipcMain.handle('agent:clear-customization', (_event, request) => {
    return agentManagement.clearCustomization(request);
  });
  ipcMain.handle('conversation:get-snapshot', () => conversationController.getSnapshot());
  ipcMain.handle('conversation:get-input-capabilities', () => {
    return conversationController.getInputCapabilities();
  });
  ipcMain.handle('conversation:get-workspaces', () => {
    return conversationController.getAuthorizedWorkspaces();
  });
  ipcMain.handle('conversation:authorize-workspace', async () => {
    const expectedAgentId = conversationController.getSnapshot().agentId;
    const options = {
      title: '授权当前 Agent 引用工作文件',
      buttonLabel: '授权此文件夹',
      properties: ['openDirectory'],
    };
    const result = window && !window.isDestroyed()
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length !== 1) {
      return conversationController.getAuthorizedWorkspaces();
    }
    if (conversationController.getSnapshot().agentId !== expectedAgentId) {
      throw new Error('Agent 已切换，请在当前对话中重新授权工作文件夹');
    }
    return conversationController.authorizeWorkspaceRoot(result.filePaths[0]);
  });
  ipcMain.handle('conversation:revoke-workspace', (_event, workspaceId) => {
    return conversationController.revokeWorkspace(workspaceId);
  });
  ipcMain.handle('conversation:search-workspace-files', (_event, request) => {
    return conversationController.searchWorkspaceFiles(request);
  });
  ipcMain.handle('conversation:stage-workspace-file', (_event, request) => {
    return conversationController.stageWorkspaceFile(request);
  });
  ipcMain.handle('conversation:search-prompt-history', (_event, query) => {
    return conversationController.searchPromptHistory(query);
  });
  ipcMain.handle('conversation:select-prompt-history', (_event, historyId) => {
    return conversationController.selectPromptHistory(historyId);
  });
  ipcMain.handle('conversation:open', (_event, agentId) => {
    return conversationController.open(agentId);
  });
  ipcMain.handle('conversation:pick-attachments', async () => {
    const expectedAgentId = conversationController.getSnapshot().agentId;
    const options = {
      title: '添加到 Agent 对话',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: '图片与文档',
          extensions: [
            'png', 'jpg', 'jpeg', 'webp', 'gif',
            'pdf', 'docx', 'xlsx', 'pptx', 'ipynb',
            'txt', 'md', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml',
            'xml', 'html', 'css', 'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx',
            'py', 'rs', 'go', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp',
            'sh', 'zsh', 'sql', 'toml',
          ],
        },
      ],
    };
    const result = window && !window.isDestroyed()
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return conversationController.getSnapshot();
    }
    if (conversationController.getSnapshot().agentId !== expectedAgentId) {
      throw new Error('Agent 已切换，请在当前对话中重新添加文件');
    }
    return conversationController.stageAttachmentPaths(result.filePaths);
  });
  ipcMain.handle('conversation:stage-paths', (_event, paths) => {
    return conversationController.stageAttachmentPaths(paths);
  });
  ipcMain.handle('conversation:stage-bytes', (_event, items) => {
    return conversationController.stageAttachmentBytes(items);
  });
  ipcMain.handle('conversation:stage-link', (_event, url) => {
    return conversationController.stageAttachmentLink(url);
  });
  ipcMain.handle('conversation:discard-attachment', (_event, attachmentId) => {
    return conversationController.discardAttachment(attachmentId);
  });
  ipcMain.handle('conversation:send', (_event, request) => {
    return conversationController.send(request);
  });
  ipcMain.handle('conversation:send-now', (_event, request) => {
    return conversationController.sendNow(request);
  });
  ipcMain.handle('conversation:interject', (_event, text) => {
    return conversationController.interject(text);
  });
  ipcMain.handle('conversation:queue-remove', (_event, queueId) => {
    return conversationController.removeQueuedPrompt(queueId);
  });
  ipcMain.handle('conversation:queue-edit', (_event, queueId, text) => {
    return conversationController.editQueuedPrompt(queueId, text);
  });
  ipcMain.handle('conversation:queue-reorder', (_event, queueIds) => {
    return conversationController.reorderQueuedPrompts(queueIds);
  });
  ipcMain.handle('conversation:queue-clear', () => {
    return conversationController.clearQueuedPrompts();
  });
  ipcMain.handle('conversation:queue-send-now', (_event, queueId) => {
    return conversationController.sendQueuedPromptNow(queueId);
  });
  ipcMain.handle('conversation:cancel-current', () => {
    return conversationController.cancelCurrentTask();
  });
  ipcMain.handle('conversation:respond-permission', (_event, interactionId, optionId) => {
    return conversationController.respondToPermission(interactionId, optionId);
  });
  ipcMain.handle('conversation:close', () => conversationController.close());
  if (dictationController) {
    const currentConversationAgentId = () => {
      const agentId = conversationController.getSnapshot()?.agentId;
      if (typeof agentId !== 'string' || !agentId) {
        throw new Error('请先打开一个 Agent 对话，再使用语音听写。');
      }
      return agentId;
    };
    ipcMain.handle('dictation:get-snapshot', () => dictationController.getSnapshot());
    ipcMain.handle('dictation:open', () => {
      return dictationController.open(currentConversationAgentId());
    });
    ipcMain.handle('dictation:start', async (_event, request = {}) => {
      if (request?.disclosureAccepted !== true) {
        throw new Error('请先确认使用 macOS 本机听写。');
      }
      const agentId = currentConversationAgentId();
      const state = await dictationController.start(agentId, {
        disclosureAccepted: request?.disclosureAccepted === true,
      });
      if (conversationController.getSnapshot()?.agentId !== agentId) {
        if (['starting', 'listening', 'transcribing'].includes(state?.phase)) {
          await localDictationService?.cancelActiveDictation?.().catch(() => {});
        }
        throw new Error('Agent 已切换，本次听写已取消。');
      }
      return state;
    });
    ipcMain.handle('dictation:stop', () => dictationController.stop());
    ipcMain.handle('dictation:cancel', () => dictationController.cancel());
    ipcMain.handle('dictation:close', () => dictationController.close());
  }
  ipcMain.handle('provider:get-snapshot', () => providers.getSnapshot());
  ipcMain.handle('provider:create-profile', (_event, { profile, apiKey } = {}) => {
    return providers.createProfile(profile, apiKey);
  });
  ipcMain.handle('provider:update-profile', (_event, { profileId, profile } = {}) => {
    return providers.updateProfile(profileId, profile);
  });
  ipcMain.handle('provider:replace-secret', (_event, { profileId, apiKey } = {}) => {
    return providers.replaceSecret(profileId, apiKey);
  });
  ipcMain.handle('provider:delete-profile', (_event, profileId) => {
    return providers.deleteProfile(profileId);
  });
  ipcMain.handle('provider:run-probe', (_event, request) => {
    return providers.runProbe(request);
  });
  ipcMain.handle('provider:test-connection', (_event, request) => {
    return providers.testConnection(request);
  });
  ipcMain.handle('provider:discover-models', (_event, request) => {
    return providers.discoverModels(request);
  });
  ipcMain.handle('package:get-snapshot', () => packages.getSnapshot());
  ipcMain.handle('package:refresh-registry', () => packages.refreshRegistry());
  ipcMain.handle('package:download', (_event, packageId) => {
    return packages.download(packageId);
  });
  ipcMain.handle('package:approve', (_event, approvalId) => {
    return packages.approve(approvalId);
  });
  ipcMain.handle('package:rollback', (_event, packageId) => {
    return packages.rollback(packageId);
  });
  ipcMain.handle('package:reconcile', (_event, packageId) => {
    return packages.reconcile(packageId);
  });
  ipcMain.handle('runtime:get-background-snapshot', () => {
    return publicBackgroundSnapshot({ host, loginItems: loginItemController });
  });
  ipcMain.handle('runtime:set-background-startup', (_event, enabled) => {
    if (typeof enabled !== 'boolean') throw new Error('后台启动设置无效');
    loginItemController.setEnabled(enabled);
    return publicBackgroundSnapshot({ host, loginItems: loginItemController });
  });
  ipcMain.handle('external:open-subscription', () => openAllowedExternal(SUBSCRIPTION_URL));
  ipcMain.handle('external:open-registration', () => openAllowedExternal(REGISTRATION_URL));
}

function openAllowedExternal(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'agentmesh360.com') {
    throw new Error('不允许打开此地址');
  }
  return shell.openExternal(parsed.toString());
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  cancelActiveLocalDictation();
  dictations?.dispose();
  localDictationService?.dispose();
  conversations?.dispose();
  conversationAttachments?.dispose().catch(() => {});
  controller?.shutdown().catch(() => {});
});

function cancelActiveLocalDictation() {
  try {
    const pending = localDictationService?.cancelActiveDictation?.();
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  } catch {
    // Lifecycle cleanup must not block window, power, or app teardown.
  }
}

module.exports = {
  createWindow,
  openAllowedExternal,
  registerIpc,
  SUBSCRIPTION_URL,
  REGISTRATION_URL,
};
