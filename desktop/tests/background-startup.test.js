'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BACKGROUND_START_FLAG,
  LoginItemController,
  WindowLifecycle,
  activateAgentAndEnableBackground,
  resolveStartupIntent,
} = require('../src/background-startup');

test('macOS login launches resolve to background without deprecated openAsHidden', () => {
  const intent = resolveStartupIntent({
    argv: ['/Applications/AgentMesh360.app/Contents/MacOS/AgentMesh360'],
    loginItemSnapshot: { wasOpenedAtLogin: true },
  });

  assert.equal(intent.background, true);
  assert.deepEqual(intent.singleInstanceData, { openWindow: false });
});

test('explicit background flag works independently of platform login metadata', () => {
  const intent = resolveStartupIntent({
    argv: ['electron', '.', BACKGROUND_START_FLAG],
    loginItemSnapshot: { wasOpenedAtLogin: false },
  });

  assert.equal(intent.background, true);
  assert.equal(intent.singleInstanceData.openWindow, false);
});

test('normal launches ask an existing background instance to open a window', () => {
  const intent = resolveStartupIntent({
    argv: ['/Applications/AgentMesh360.app/Contents/MacOS/AgentMesh360'],
    loginItemSnapshot: { wasOpenedAtLogin: false },
  });

  assert.equal(intent.background, false);
  assert.equal(intent.singleInstanceData.openWindow, true);
});

test('Login Item writes are disabled for unpackaged development builds', () => {
  const writes = [];
  const controller = new LoginItemController({
    app: {
      isPackaged: false,
      getLoginItemSettings: () => ({ openAtLogin: false, wasOpenedAtLogin: false }),
      setLoginItemSettings: (settings) => writes.push(settings),
    },
    platform: 'darwin',
  });

  const result = controller.setEnabled(true);

  assert.equal(result.supported, false);
  assert.equal(result.reason, 'packaged_app_required');
  assert.deepEqual(writes, []);
  assert.equal(controller.getSnapshot().supported, false);
});

test('packaged macOS activation enables the main app Login Item without openAsHidden', () => {
  const writes = [];
  let openAtLogin = false;
  const controller = new LoginItemController({
    app: {
      isPackaged: true,
      getLoginItemSettings: () => ({
        openAtLogin,
        wasOpenedAtLogin: false,
        status: openAtLogin ? 'enabled' : 'not-registered',
      }),
      setLoginItemSettings: (settings) => {
        writes.push(settings);
        openAtLogin = settings.openAtLogin;
      },
    },
    platform: 'darwin',
  });

  const result = controller.setEnabled(true);

  assert.deepEqual(writes, [{ openAtLogin: true }]);
  assert.equal(Object.hasOwn(writes[0], 'openAsHidden'), false);
  assert.equal(result.openAtLogin, true);
  assert.equal(result.status, 'enabled');
});

test('Windows Login Item uses the explicit background flag', () => {
  const writes = [];
  const controller = new LoginItemController({
    app: {
      isPackaged: true,
      getLoginItemSettings: () => ({ openAtLogin: true }),
      setLoginItemSettings: (settings) => writes.push(settings),
    },
    platform: 'win32',
    execPath: 'C:\\Program Files\\AgentMesh360\\AgentMesh360.exe',
  });

  controller.setEnabled(true);

  assert.equal(writes[0].openAtLogin, true);
  assert.deepEqual(writes[0].args, [BACKGROUND_START_FLAG]);
  assert.equal(writes[0].path, 'C:\\Program Files\\AgentMesh360\\AgentMesh360.exe');
});

test('background Window lifecycle creates no Renderer until a normal second instance arrives', () => {
  const calls = [];
  const window = fakeWindow(calls);
  const lifecycle = new WindowLifecycle({
    background: true,
    createWindow: () => {
      calls.push('create');
      return window;
    },
    dock: {
      hide: () => calls.push('dock-hide'),
      show: () => calls.push('dock-show'),
    },
  });

  lifecycle.onReady();
  assert.equal(lifecycle.hasWindow(), false);
  assert.deepEqual(calls, ['dock-hide']);

  lifecycle.handleSecondInstance({ openWindow: false });
  assert.equal(lifecycle.hasWindow(), false);

  lifecycle.handleSecondInstance({ openWindow: true });
  assert.equal(lifecycle.hasWindow(), true);
  assert.deepEqual(calls, ['dock-hide', 'dock-show', 'create']);
});

test('normal Window lifecycle restores and focuses the existing window', () => {
  const calls = [];
  const window = fakeWindow(calls, { minimized: true });
  const lifecycle = new WindowLifecycle({
    background: false,
    createWindow: () => {
      calls.push('create');
      return window;
    },
  });

  lifecycle.onReady();
  lifecycle.open();

  assert.deepEqual(calls, ['create', 'restore', 'show', 'focus']);
});

test('first successful Agent activation enables packaged background startup once', async () => {
  let state = {
    phase: 'ready',
    agents: [{ agentId: 'job-agent', desiredState: 'stopped' }],
  };
  const writes = [];
  const identity = {
    getState: () => state,
    async activateAgent() {
      state = {
        phase: 'ready',
        agents: [{
          agentId: 'job-agent',
          desiredState: 'running',
          runtimeState: 'resident',
        }],
      };
      return state;
    },
  };
  const loginItems = { setEnabled: (enabled) => writes.push(enabled) };

  await activateAgentAndEnableBackground({
    identity,
    loginItems,
    agentId: 'job-agent',
  });
  await activateAgentAndEnableBackground({
    identity,
    loginItems,
    agentId: 'job-agent',
  });

  assert.deepEqual(writes, [true]);
});

test('Login Item refusal does not roll back a successful Agent activation', async () => {
  const expected = {
    phase: 'ready',
    agents: [{
      agentId: 'job-agent',
      desiredState: 'running',
      runtimeState: 'resident',
    }],
  };
  const result = await activateAgentAndEnableBackground({
    identity: {
      getState: () => ({
        phase: 'ready',
        agents: [{ agentId: 'job-agent', desiredState: 'stopped' }],
      }),
      activateAgent: async () => expected,
    },
    loginItems: {
      setEnabled: () => { throw new Error('OS approval required'); },
    },
    agentId: 'job-agent',
  });

  assert.equal(result, expected);
});

test('failed Agent activation is rejected instead of being reported as ready', async () => {
  const writes = [];
  const failedState = {
    phase: 'ready',
    activationError: 'Agent Host 初始化失败',
    agents: [{ agentId: 'job-agent', desiredState: 'stopped' }],
  };

  await assert.rejects(
    activateAgentAndEnableBackground({
      identity: {
        getState: () => ({
          phase: 'ready',
          agents: [{ agentId: 'job-agent', desiredState: 'stopped' }],
        }),
        activateAgent: async () => failedState,
      },
      loginItems: { setEnabled: (enabled) => writes.push(enabled) },
      agentId: 'job-agent',
    }),
    (error) => (
      error.code === 'agent_activation_failed'
      && error.message === 'Agent Host 初始化失败'
    ),
  );

  assert.deepEqual(writes, []);
});

test('an old running/error projection cannot turn a failed retry into activation success', async () => {
  const writes = [];
  const failedState = {
    phase: 'ready',
    activationError: 'Agent 激活失败，请稍后重试',
    agents: [{
      agentId: 'job-agent',
      desiredState: 'running',
      runtimeState: 'error',
    }],
  };

  await assert.rejects(
    activateAgentAndEnableBackground({
      identity: {
        getState: () => failedState,
        activateAgent: async () => failedState,
      },
      loginItems: { setEnabled: (enabled) => writes.push(enabled) },
      agentId: 'job-agent',
    }),
    (error) => (
      error.code === 'agent_activation_failed'
      && error.message === 'Agent 激活失败，请稍后重试'
    ),
  );

  assert.deepEqual(writes, []);
});

function fakeWindow(calls, { minimized = false } = {}) {
  return {
    isDestroyed: () => false,
    isMinimized: () => minimized,
    restore: () => {
      minimized = false;
      calls.push('restore');
    },
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
  };
}
