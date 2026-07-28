'use strict';

const path = require('node:path');
const {
  app,
  BrowserWindow,
  ipcMain,
  powerMonitor,
  safeStorage,
  session,
  shell,
} = require('electron');
const { AgentMeshCoreClient } = require('./auth/core-client');
const { SecureTokenStore } = require('./auth/secure-token-store');
const { AcpHostClient } = require('./host/acp-client');
const { AgentConversationController } = require('./conversation-controller');
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
let lastFocusCheck = 0;
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
  const tokenStore = new SecureTokenStore({
    safeStorage,
    filePath: path.join(app.getPath('userData'), 'identity', 'refresh-token.secure.json'),
  });
  const host = new AcpHostClient();
  controller = new IdentityController({ core, tokenStore, host });
  conversations = new AgentConversationController({
    identity: controller,
    host,
    activateAgent: (agentId) => activateAgentAndEnableBackground({
      identity: controller,
      loginItems,
      agentId,
    }),
  });
  const packages = new PackageController({ identity: controller, host });
  const providers = new ProviderController({ identity: controller, host });

  registerIpc(controller, providers, packages, conversations, loginItems, host);
  windows.onReady();
  controller.subscribe((state) => {
    if (!window?.isDestroyed()) window.webContents.send('identity:state', state);
  });
  conversations.subscribe((state) => {
    if (!window?.isDestroyed()) window.webContents.send('conversation:state', state);
  });
  powerMonitor.on('resume', () => controller.revalidate('resume').catch(() => {}));
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
  created.on('focus', () => {
    const now = Date.now();
    if (!controller || now - lastFocusCheck < 30_000) return;
    lastFocusCheck = now;
    controller.revalidate('focus').catch(() => {});
  });
  created.once('ready-to-show', () => created.show());
  created.on('closed', () => {
    if (window === created) window = null;
  });
  created.loadFile(path.join(__dirname, 'ui', 'index.html'));
  return created;
}

function registerIpc(identity, providers, packages, conversationController, loginItemController, host) {
  ipcMain.handle('identity:get-state', () => identity.getState());
  ipcMain.handle('identity:login', (_event, credentials) => {
    const email = typeof credentials?.email === 'string' ? credentials.email : '';
    const password = typeof credentials?.password === 'string' ? credentials.password : '';
    return identity.login(email, password);
  });
  ipcMain.handle('identity:logout', () => identity.logout());
  ipcMain.handle('identity:recheck', () => identity.revalidate('manual'));
  ipcMain.handle('agent:activate', async (_event, agentId) => {
    if (!/^[a-z0-9][a-z0-9-]{1,98}[a-z0-9]$/.test(agentId)) throw new Error('Agent ID 无效');
    return activateAgentAndEnableBackground({
      identity,
      loginItems: loginItemController,
      agentId,
    });
  });
  ipcMain.handle('conversation:get-snapshot', () => conversationController.getSnapshot());
  ipcMain.handle('conversation:open', (_event, agentId) => {
    return conversationController.open(agentId);
  });
  ipcMain.handle('conversation:send', (_event, text) => {
    return conversationController.send(text);
  });
  ipcMain.handle('conversation:respond-permission', (_event, interactionId, optionId) => {
    return conversationController.respondToPermission(interactionId, optionId);
  });
  ipcMain.handle('conversation:close', () => conversationController.close());
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
  ipcMain.handle('provider:upsert-assignment', (_event, assignment) => {
    return providers.upsertAssignment(assignment);
  });
  ipcMain.handle('provider:delete-assignment', (_event, assignmentId) => {
    return providers.deleteAssignment(assignmentId);
  });
  ipcMain.handle('provider:run-probe', (_event, request) => {
    return providers.runProbe(request);
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
  conversations?.dispose();
  controller?.shutdown().catch(() => {});
});

module.exports = {
  createWindow,
  openAllowedExternal,
  registerIpc,
  SUBSCRIPTION_URL,
  REGISTRATION_URL,
};
