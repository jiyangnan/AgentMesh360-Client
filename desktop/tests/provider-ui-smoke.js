'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh360-provider-ui-'));
app.setPath('userData', userData);
app.commandLine.appendSwitch('disable-gpu');

const writes = [];
let providerFailure = null;

app.whenReady().then(async () => {
  ipcMain.handle('identity:get-state', () => readyState());
  ipcMain.handle('conversation:get-snapshot', () => ({ phase: 'idle' }));
  ipcMain.handle('agent:get-model-overview', () => ({
    agents: readyState().agents.map((agent) => ({
      agentId: agent.agentId,
      providerProfileId: 'pp_existing',
      providerDisplayName: 'Existing Provider',
      modelId: 'existing-model',
      bindingIssue: null,
      inheritedFromLegacyGlobal: false,
    })),
  }));
  ipcMain.handle('runtime:get-background-snapshot', () => ({
    host: { bridgeState: 'connected', mode: 'persistent_leader' },
    loginItem: { supported: true, openAtLogin: true },
  }));
  ipcMain.handle('provider:get-snapshot', () => {
    if (providerFailure) throw providerFailure;
    return providerSnapshot();
  });
  ipcMain.handle('provider:create-profile', (_event, payload) => {
    writes.push({ kind: 'profile', payload });
    return { profile: providerSnapshot().profiles[0] };
  });
  ipcMain.handle('provider:test-connection', (_event, payload) => {
    writes.push({ kind: 'connection-test', payload });
    return {
      connectionTest: {
        status: 'passed',
        modelId: payload.modelId,
        networkAttempted: true,
        mayIncurCost: true,
        summaryCode: 'minimal_inference_responded',
      },
    };
  });
  ipcMain.handle('provider:discover-models', (_event, payload) => {
    writes.push({ kind: 'model-discovery', payload });
    return {
      modelDiscovery: {
        status: 'passed',
        authenticationVerified: true,
        mayIncurCost: false,
        models: [
          { modelId: 'gpt-5', displayName: 'GPT-5' },
          { modelId: 'gpt-5-mini', displayName: 'GPT-5 mini' },
        ],
        truncated: false,
        summaryCode: 'model_discovery_succeeded',
      },
    };
  });
  ipcMain.handle('provider:run-probe', (_event, payload) => {
    writes.push({ kind: 'probe', payload });
    return {
      probe: {
        probeId: `probe_${writes.length}`,
        providerProfileId: payload.profileId,
        modelId: payload.modelId,
        level: payload.level,
        status: 'passed',
        networkAttempted: payload.level === 'minimal_inference',
        mayIncurCost: payload.level === 'minimal_inference',
        completedAt: new Date().toISOString(),
      },
    };
  });
  for (const channel of [
    'identity:login',
    'identity:logout',
    'identity:recheck',
    'agent:activate',
    'external:open-subscription',
    'external:open-registration',
    'provider:update-profile',
    'provider:replace-secret',
    'provider:delete-profile',
  ]) {
    ipcMain.handle(channel, () => ({}));
  }

  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    show: false,
    backgroundColor: '#090d16',
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await window.loadFile(path.join(__dirname, '..', 'src', 'ui', 'index.html'));
  await window.webContents.executeJavaScript("document.getElementById('nav-providers').click()");
  await waitFor(async () => window.webContents.executeJavaScript(
    "document.getElementById('provider-profile-form') !== null",
  ));
  const officialPresetIds = await window.webContents.executeJavaScript(
    "[...document.querySelectorAll('#provider-preset optgroup[label^=\"官方\"] option')].map((option) => option.value)",
  );
  assert.deepEqual(officialPresetIds, [
    'openai',
    'xai',
    'anthropic',
    'google-gemini',
    'deepseek',
    'glm',
    'glm-coding-plan',
    'kimi',
    'kimi-cn',
    'kimi-coding-plan',
  ]);

  await window.webContents.executeJavaScript(`
    (() => {
      const form = document.getElementById('provider-profile-form');
      form.dataset.revalidationGuard = 'original-form';
      form.elements.presetId.value = '__custom__';
      form.elements.presetId.dispatchEvent(new Event('change', { bubbles: true }));
      form.elements.displayName.value = '尚未保存的 Provider';
      form.elements.baseUrl.value = 'https://draft.example.com/v1';
      form.elements.manualModel.value = 'draft-model';
      form.elements.apiKey.value = 'sk-unsaved-draft';
    })()
  `);
  window.webContents.send('identity:state', {
    ...readyState(),
    account: {
      ...readyState().account,
      displayName: 'Ferdinand Revalidated',
    },
    credits: { balance: 955 },
    checkedAt: '2026-07-30T08:00:00.000Z',
    revalidatedBy: 'focus',
    validationRevision: 2,
  });
  await waitFor(async () => window.webContents.executeJavaScript(
    "document.querySelector('[data-ready-account-name]')?.textContent === 'Ferdinand Revalidated'",
  ));
  const preservedDraft = await window.webContents.executeJavaScript(`(() => {
    const form = document.getElementById('provider-profile-form');
    return {
      sameForm: form?.dataset.revalidationGuard === 'original-form',
      displayName: form?.elements.displayName.value,
      baseUrl: form?.elements.baseUrl.value,
      manualModel: form?.elements.manualModel.value,
      apiKey: form?.elements.apiKey.value,
      spinnerVisible: document.querySelector('.state-card .spinner') !== null,
    };
  })()`);
  assert.deepEqual(preservedDraft, {
    sameForm: true,
    displayName: '尚未保存的 Provider',
    baseUrl: 'https://draft.example.com/v1',
    manualModel: 'draft-model',
    apiKey: 'sk-unsaved-draft',
    spinnerVisible: false,
  });

  await window.webContents.executeJavaScript(`
    (() => {
      document.getElementById('nav-agents').click();
      document.getElementById('nav-providers').click();
    })()
  `);
  await waitFor(async () => window.webContents.executeJavaScript(
    "document.getElementById('provider-profile-form') !== null",
  ));
  const preservedAfterNavigation = await window.webContents.executeJavaScript(`(() => {
    const form = document.getElementById('provider-profile-form');
    return {
      presetId: form?.elements.presetId.value,
      displayName: form?.elements.displayName.value,
      baseUrl: form?.elements.baseUrl.value,
      manualModel: form?.elements.manualModel.value,
      apiKey: form?.elements.apiKey.value,
      secretInMarkup: document.documentElement.innerHTML.includes('sk-unsaved-draft'),
    };
  })()`);
  assert.deepEqual(preservedAfterNavigation, {
    presetId: '__custom__',
    displayName: '尚未保存的 Provider',
    baseUrl: 'https://draft.example.com/v1',
    manualModel: 'draft-model',
    apiKey: 'sk-unsaved-draft',
    secretInMarkup: false,
  });

  window.webContents.send('identity:state', {
    ...readyState(),
    account: { id: 8, email: 'other@example.com', displayName: 'Other Account' },
    validationRevision: 1,
  });
  await waitFor(async () => window.webContents.executeJavaScript(
    "document.querySelector('[data-ready-account-name]')?.textContent === 'Other Account'",
  ));
  await window.webContents.executeJavaScript(
    "document.getElementById('nav-providers').click()",
  );
  await waitFor(async () => window.webContents.executeJavaScript(
    "document.getElementById('provider-profile-form') !== null",
  ));
  const isolatedAccountDraft = await window.webContents.executeJavaScript(`(() => {
    const form = document.getElementById('provider-profile-form');
    return {
      presetId: form?.elements.presetId.value,
      displayName: form?.elements.displayName.value,
      apiKey: form?.elements.apiKey.value,
    };
  })()`);
  assert.deepEqual(isolatedAccountDraft, {
    presetId: '',
    displayName: '',
    apiKey: '',
  });

  window.webContents.send('identity:state', {
    ...readyState(),
    validationRevision: 3,
  });
  await waitFor(async () => window.webContents.executeJavaScript(
    "document.querySelector('[data-ready-account-name]')?.textContent === 'Ferdinand'",
  ));
  await window.webContents.executeJavaScript(
    "document.getElementById('nav-providers').click()",
  );
  await waitFor(async () => window.webContents.executeJavaScript(
    "document.getElementById('provider-profile-form') !== null",
  ));

  await window.webContents.executeJavaScript(`
    (() => {
      const form = document.getElementById('provider-profile-form');
      form.elements.presetId.value = 'openai';
      form.elements.presetId.dispatchEvent(new Event('change', { bubbles: true }));
      form.elements.apiKey.value = 'sk-renderer-one-shot';
      form.requestSubmit();
    })()
  `);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(writes.some((write) => write.kind === 'profile'), false);
  const simplifiedProvider = await window.webContents.executeJavaScript(`({
    managedVisible: !document.getElementById('managed-provider-card').hidden,
    advancedHidden: document.getElementById('advanced-provider-settings').hidden,
    saveDisabled: document.querySelector('.provider-save-button').disabled,
    modelDisabled: document.getElementById('provider-model-select').disabled,
    bodyText: document.body.innerText,
  })`);
  assert.equal(simplifiedProvider.managedVisible, true);
  assert.equal(simplifiedProvider.advancedHidden, true);
  assert.equal(simplifiedProvider.saveDisabled, true);
  assert.equal(simplifiedProvider.modelDisabled, true);
  assert.equal(simplifiedProvider.bodyText.includes('不需要判断技术选项'), true);
  assert.equal(simplifiedProvider.bodyText.includes('请先测试连接'), true);
  assert.equal(simplifiedProvider.bodyText.includes('验证 Key 并获取模型'), true);

  await window.webContents.executeJavaScript(`
    (() => {
      document.getElementById('provider-discover-models').click();
    })()
  `);
  await waitFor(() => writes.some((write) => write.kind === 'model-discovery'));
  const discoveryWrite = writes.find((write) => write.kind === 'model-discovery');
  assert.equal(discoveryWrite.payload.apiKey, 'sk-renderer-one-shot');
  assert.deepEqual(discoveryWrite.payload.profile.enabledModels, []);
  await waitFor(async () => window.webContents.executeJavaScript(
    "document.getElementById('model-discovery-status').dataset.status === 'passed'",
  ));
  const discoveredModels = await window.webContents.executeJavaScript(`(() => {
    const select = document.getElementById('provider-model-select');
    return {
      disabled: select.disabled,
      values: [...select.options].map((option) => option.value).filter(Boolean),
      saveDisabled: document.querySelector('.provider-save-button').disabled,
    };
  })()`);
  assert.deepEqual(discoveredModels, {
    disabled: false,
    values: ['gpt-5', 'gpt-5-mini'],
    saveDisabled: true,
  });

  await window.webContents.executeJavaScript(`
    (() => {
      const select = document.getElementById('provider-model-select');
      select.value = 'gpt-5';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      window.confirm = () => true;
      document.getElementById('provider-test-connection').click();
    })()
  `);
  await waitFor(() => writes.some((write) => write.kind === 'connection-test'));
  assert.equal(writes.find((write) => write.kind === 'connection-test').payload.apiKey,
    'sk-renderer-one-shot');
  assert.equal(writes.find((write) => write.kind === 'connection-test').payload.modelId,
    'gpt-5');
  await waitFor(async () => window.webContents.executeJavaScript(
    "document.getElementById('connection-test-status').dataset.status === 'passed'",
  ));
  await window.webContents.executeJavaScript(
    "document.getElementById('provider-profile-form').requestSubmit()",
  );
  await waitFor(() => writes.some((write) => write.kind === 'profile'));
  assert.equal(
    writes.find((write) => write.kind === 'profile').payload.apiKey,
    'sk-renderer-one-shot',
  );
  await waitFor(async () => window.webContents.executeJavaScript(`
    document.querySelector('.provider-notice.success') !== null
      && document.querySelector('[name="presetId"]')?.value === ''
      && document.querySelector('[name="displayName"]')?.value === ''
      && document.querySelector('[name="apiKey"]')?.value === ''
  `));
  const publicDom = await window.webContents.executeJavaScript(`({
    apiKeyValue: document.querySelector('[name="apiKey"]').value,
    presetId: document.querySelector('[name="presetId"]').value,
    displayName: document.querySelector('[name="displayName"]').value,
    secretInMarkup: document.documentElement.innerHTML.includes('sk-renderer-one-shot'),
    bodyText: document.body.innerText,
  })`);
  assert.equal(publicDom.apiKeyValue, '');
  assert.equal(publicDom.presetId, '');
  assert.equal(publicDom.displayName, '');
  assert.equal(publicDom.secretInMarkup, false);
  assert.equal(publicDom.bodyText.includes('sk-renderer-one-shot'), false);

  await window.webContents.executeJavaScript(
    "document.querySelector('[data-edit-profile=\"pp_openai\"]').click()",
  );
  await waitFor(async () => window.webContents.executeJavaScript(
    "document.querySelector('[name=\"displayName\"]')?.value === 'Personal OpenAI'",
  ));
  await window.webContents.executeJavaScript(
    "document.getElementById('cancel-profile-edit').click()",
  );
  assert.equal(await window.webContents.executeJavaScript(
    "document.querySelector('[name=\"presetId\"]').value",
  ), '');

  const providerBoundary = await window.webContents.executeJavaScript(`({
    assignmentForm: document.getElementById('provider-assignment-form') !== null,
    routeMatrix: document.querySelector('.assignment-stack') !== null,
    body: document.body.innerText,
  })`);
  assert.equal(providerBoundary.assignmentForm, false);
  assert.equal(providerBoundary.routeMatrix, false);
  assert.equal(providerBoundary.body.includes('分配模型角色'), false);
  assert.equal(providerBoundary.body.includes('当前路由矩阵'), false);
  await waitFor(async () => window.webContents.executeJavaScript(
    "document.querySelector('[data-probe-level=\"minimal_inference\"]') !== null",
  ));

  await window.webContents.executeJavaScript(`
    (() => {
      window.confirm = () => false;
      document.querySelector('[data-probe-level="minimal_inference"]').click();
    })()
  `);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(writes.some((write) => write.kind === 'probe'), false);

  await window.webContents.executeJavaScript(
    "document.querySelector('[data-probe-level=\"local_validation\"]').click()",
  );
  await waitFor(() => writes.some((write) => write.kind === 'probe'));
  assert.deepEqual(
    writes.find((write) => write.kind === 'probe').payload,
    {
      profileId: 'pp_openai',
      modelId: 'gpt-5',
      level: 'local_validation',
      confirmPaidInference: false,
    },
  );
  await waitFor(async () => window.webContents.executeJavaScript(
    "document.querySelector('[data-probe-level=\"minimal_inference\"]') !== null",
  ));

  await window.webContents.executeJavaScript(`
    (() => {
      window.confirm = () => true;
      document.querySelector('[data-probe-level="minimal_inference"]').click();
    })()
  `);
  await waitFor(() => writes.filter((write) => write.kind === 'probe').length === 2);
  assert.deepEqual(
    writes.filter((write) => write.kind === 'probe')[1].payload,
    {
      profileId: 'pp_openai',
      modelId: 'gpt-5',
      level: 'minimal_inference',
      confirmPaidInference: true,
    },
  );
  const probeDom = await window.webContents.executeJavaScript('document.body.innerText');
  assert.equal(probeDom.includes('模型已真实响应'), true);
  assert.equal(probeDom.includes('sk-renderer-one-shot'), false);

  providerFailure = new Error(
    "Error invoking remote method 'provider:get-snapshot': HostRequestError: Authentication required",
  );
  const errorWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    show: false,
    backgroundColor: '#090d16',
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await errorWindow.loadFile(path.join(__dirname, '..', 'src', 'ui', 'index.html'));
  await errorWindow.webContents.executeJavaScript("document.getElementById('nav-providers').click()");
  await waitFor(async () => errorWindow.webContents.executeJavaScript(
    "document.querySelector('.retry-providers') !== null",
  ));
  const errorText = await errorWindow.webContents.executeJavaScript('document.body.innerText');
  assert.equal(errorText.includes('本地身份正在恢复，请稍后重试。'), true);
  assert.equal(errorText.includes('provider:get-snapshot'), false);
  assert.equal(errorText.includes('HostRequestError'), false);
  errorWindow.destroy();
  window.destroy();
  fs.rmSync(userData, { recursive: true, force: true });
  app.exit(0);
}).catch((error) => {
  fs.rmSync(userData, { recursive: true, force: true });
  console.error(error);
  app.exit(1);
});

async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('provider UI smoke timed out');
}

function readyState() {
  return {
    phase: 'ready',
    account: { id: 7, email: 'ferdinand@example.com', displayName: 'Ferdinand' },
    subscription: { status: 'active', plan: 'Pro' },
    credits: { balance: 0 },
    access: { canEnterClient: true, reason: 'subscription_active' },
    agents: [
      {
        agentId: 'job-agent',
        displayName: 'Job Agent',
        description: 'Career copilot',
        desiredState: 'running',
        runtimeState: 'resident',
      },
    ],
    checkedAt: new Date().toISOString(),
    validationRevision: 1,
  };
}

function providerSnapshot() {
  return {
    profiles: [
      {
        profileId: 'pp_openai',
        presetId: 'openai',
        displayName: 'Personal OpenAI',
        protocol: 'openai_responses',
        baseUrl: 'https://api.openai.com/v1',
        authKind: 'bearer_api_key',
        enabledModels: ['gpt-5'],
        credentialConfigured: true,
        credentialLastFour: '7K2M',
      },
    ],
    catalog: {
      schemaVersion: 1,
      catalogRevision: 3,
      providers: [
        {
          presetId: 'openai',
          displayName: 'OpenAI',
          classification: 'official',
          protocol: 'openai_responses',
          defaultBaseUrl: 'https://api.openai.com/v1',
          authKind: 'bearer_api_key',
          models: [{ modelId: 'gpt-5' }],
        },
        {
          presetId: 'xai',
          displayName: 'xAI',
          classification: 'official',
          protocol: 'openai_responses',
          defaultBaseUrl: 'https://api.x.ai/v1',
          authKind: 'bearer_api_key',
          models: [],
        },
        {
          presetId: 'anthropic',
          displayName: 'Anthropic',
          classification: 'official',
          protocol: 'anthropic_messages',
          defaultBaseUrl: 'https://api.anthropic.com/v1',
          authKind: 'x_api_key',
          models: [],
        },
        {
          presetId: 'google-gemini',
          displayName: 'Google Gemini',
          classification: 'official',
          protocol: 'openai_chat',
          defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
          authKind: 'bearer_api_key',
          models: [],
        },
        {
          presetId: 'deepseek',
          displayName: 'DeepSeek',
          classification: 'official',
          protocol: 'openai_chat',
          defaultBaseUrl: 'https://api.deepseek.com/v1',
          authKind: 'bearer_api_key',
          models: [],
        },
        {
          presetId: 'glm',
          displayName: '智谱 GLM API',
          classification: 'official',
          protocol: 'openai_chat',
          defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
          authKind: 'bearer_api_key',
          models: [],
        },
        {
          presetId: 'glm-coding-plan',
          displayName: '智谱 GLM Coding Plan',
          classification: 'official',
          protocol: 'openai_chat',
          defaultBaseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
          authKind: 'bearer_api_key',
          models: [],
        },
        {
          presetId: 'kimi',
          displayName: 'Kimi API（国际）',
          classification: 'official',
          protocol: 'openai_chat',
          defaultBaseUrl: 'https://api.moonshot.ai/v1',
          authKind: 'bearer_api_key',
          models: [],
        },
        {
          presetId: 'kimi-cn',
          displayName: 'Kimi API（中国）',
          classification: 'official',
          protocol: 'openai_chat',
          defaultBaseUrl: 'https://api.moonshot.cn/v1',
          authKind: 'bearer_api_key',
          models: [],
        },
        {
          presetId: 'kimi-coding-plan',
          displayName: 'Kimi Coding Plan',
          classification: 'official',
          protocol: 'openai_chat',
          defaultBaseUrl: 'https://api.kimi.com/coding/v1',
          authKind: 'bearer_api_key',
          models: [
            { modelId: 'kimi-for-coding' },
            { modelId: 'kimi-for-coding-highspeed' },
          ],
        },
      ],
    },
    assignments: [
      {
        assignmentId: 'ma_global_main',
        scopeKind: 'global',
        scopeId: null,
        role: 'main',
        providerProfileId: 'pp_openai',
        modelId: 'gpt-5',
      },
    ],
    probes: [],
  };
}
