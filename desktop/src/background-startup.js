'use strict';

const BACKGROUND_START_FLAG = '--agentmesh360-background';

class LoginItemController {
  constructor({
    app,
    platform = process.platform,
    execPath = process.execPath,
  }) {
    this.app = app;
    this.platform = platform;
    this.execPath = execPath;
  }

  getSnapshot() {
    if (!this.app.isPackaged) {
      return publicLoginItemSnapshot({
        supported: false,
        reason: 'packaged_app_required',
      });
    }
    if (!['darwin', 'win32'].includes(this.platform)) {
      return publicLoginItemSnapshot({
        supported: false,
        reason: 'platform_unsupported',
      });
    }
    try {
      const settings = this.app.getLoginItemSettings(this.#queryOptions());
      return publicLoginItemSnapshot({
        supported: true,
        openAtLogin: settings.openAtLogin === true,
        wasOpenedAtLogin: this.platform === 'darwin' && settings.wasOpenedAtLogin === true,
        status: this.platform === 'darwin' ? settings.status : null,
      });
    } catch {
      return publicLoginItemSnapshot({
        supported: false,
        reason: 'settings_unavailable',
      });
    }
  }

  setEnabled(enabled) {
    if (!this.app.isPackaged) {
      return publicLoginItemSnapshot({
        supported: false,
        reason: 'packaged_app_required',
      });
    }
    if (!['darwin', 'win32'].includes(this.platform)) {
      return publicLoginItemSnapshot({
        supported: false,
        reason: 'platform_unsupported',
      });
    }
    this.app.setLoginItemSettings(this.#writeSettings(enabled === true));
    return this.getSnapshot();
  }

  #queryOptions() {
    if (this.platform !== 'win32') return undefined;
    return {
      path: this.execPath,
      args: [BACKGROUND_START_FLAG],
    };
  }

  #writeSettings(enabled) {
    const settings = { openAtLogin: enabled };
    if (this.platform === 'win32') {
      settings.path = this.execPath;
      settings.args = [BACKGROUND_START_FLAG];
    }
    return settings;
  }
}

class WindowLifecycle {
  constructor({
    background = false,
    createWindow,
    dock = null,
  }) {
    this.createWindow = createWindow;
    this.dock = dock;
    this.ready = false;
    this.openRequested = !background;
    this.window = null;
  }

  onReady() {
    this.ready = true;
    if (this.openRequested) return this.open();
    this.dock?.hide?.();
    return null;
  }

  open() {
    this.openRequested = true;
    if (!this.ready) return null;
    this.dock?.show?.();
    if (!this.window || this.window.isDestroyed?.()) {
      this.window = this.createWindow();
      return this.window;
    }
    if (this.window.isMinimized?.()) this.window.restore();
    this.window.show?.();
    this.window.focus?.();
    return this.window;
  }

  handleSecondInstance(additionalData) {
    if (additionalData?.openWindow === false) return null;
    return this.open();
  }

  hasWindow() {
    return Boolean(this.window && !this.window.isDestroyed?.());
  }
}

async function activateAgentAndEnableBackground({
  identity,
  loginItems,
  agentId,
}) {
  const wasRunning = identity.getState().agents
    ?.some((agent) => agent.agentId === agentId && agent.desiredState === 'running') === true;
  const state = await identity.activateAgent(agentId);
  const activatedAgent = state.agents?.find((agent) => agent.agentId === agentId);
  const isRunning = (
    state.phase === 'ready'
    && !state.activationError
    && activatedAgent?.desiredState === 'running'
    && ['resident', 'working', 'needs_input', 'dormant', 'starting']
      .includes(activatedAgent?.runtimeState)
  );
  if (!isRunning) {
    const error = new Error(
      state?.activationError || 'Agent 激活未完成，请重新尝试。',
    );
    error.code = 'agent_activation_failed';
    throw error;
  }
  if (!wasRunning && isRunning) {
    try {
      loginItems.setEnabled(true);
    } catch {
      // Agent activation remains valid when the OS refuses a Login Item.
    }
  }
  return state;
}

function resolveStartupIntent({
  argv = process.argv,
  loginItemSnapshot = {},
} = {}) {
  const explicitBackground = argv.includes(BACKGROUND_START_FLAG);
  const openedAtLogin = loginItemSnapshot.wasOpenedAtLogin === true;
  const background = explicitBackground || openedAtLogin;
  return Object.freeze({
    background,
    singleInstanceData: Object.freeze({ openWindow: !background }),
  });
}

function publicLoginItemSnapshot({
  supported,
  openAtLogin = false,
  wasOpenedAtLogin = false,
  status = null,
  reason = null,
}) {
  return Object.freeze({
    supported: supported === true,
    openAtLogin: openAtLogin === true,
    wasOpenedAtLogin: wasOpenedAtLogin === true,
    status: typeof status === 'string' ? status : null,
    reason: typeof reason === 'string' ? reason : null,
  });
}

function publicBackgroundSnapshot({ host, loginItems }) {
  return Object.freeze({
    host: host.getRuntimeStatus(),
    loginItem: loginItems.getSnapshot(),
  });
}

module.exports = {
  BACKGROUND_START_FLAG,
  LoginItemController,
  WindowLifecycle,
  activateAgentAndEnableBackground,
  publicBackgroundSnapshot,
  publicLoginItemSnapshot,
  resolveStartupIntent,
};
