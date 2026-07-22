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
const { IdentityController } = require('./identity-controller');

const SUBSCRIPTION_URL = 'https://agentmesh360.com/app/#pricing';
const REGISTRATION_URL = 'https://agentmesh360.com/app/#register';

let window = null;
let controller = null;
let lastFocusCheck = 0;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
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

  registerIpc(controller);
  window = createWindow();
  controller.subscribe((state) => {
    if (!window?.isDestroyed()) window.webContents.send('identity:state', state);
  });
  powerMonitor.on('resume', () => controller.revalidate('resume').catch(() => {}));
  await controller.start();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) window = createWindow();
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
  created.loadFile(path.join(__dirname, 'ui', 'index.html'));
  return created;
}

function registerIpc(identity) {
  ipcMain.handle('identity:get-state', () => identity.getState());
  ipcMain.handle('identity:login', (_event, credentials) => {
    const email = typeof credentials?.email === 'string' ? credentials.email : '';
    const password = typeof credentials?.password === 'string' ? credentials.password : '';
    return identity.login(email, password);
  });
  ipcMain.handle('identity:logout', () => identity.logout());
  ipcMain.handle('identity:recheck', () => identity.revalidate('manual'));
  ipcMain.handle('agent:activate', (_event, agentId) => {
    if (!/^[a-z0-9][a-z0-9-]{1,98}[a-z0-9]$/.test(agentId)) throw new Error('Agent ID 无效');
    return identity.activateAgent(agentId);
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
  controller?.shutdown().catch(() => {});
});

module.exports = { createWindow, openAllowedExternal, SUBSCRIPTION_URL, REGISTRATION_URL };
