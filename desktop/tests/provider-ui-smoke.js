'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const writes = [];
let providerFailure = null;

app.whenReady().then(async () => {
  ipcMain.handle('identity:get-state', () => readyState());
  ipcMain.handle('conversation:get-snapshot', () => ({ phase: 'idle' }));
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
  ipcMain.handle('provider:upsert-assignment', (_event, assignment) => {
    writes.push({ kind: 'assignment', payload: assignment });
    return { assignment: providerSnapshot().assignments[0] };
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
    'provider:delete-assignment',
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

  await window.webContents.executeJavaScript(`
    (() => {
      const form = document.getElementById('provider-profile-form');
      form.dataset.revalidationGuard = 'original-form';
      form.elements.displayName.value = '尚未保存的 Provider';
      form.elements.baseUrl.value = 'https://draft.example.com/v1';
      form.elements.enabledModels.value = 'draft-model';
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
      enabledModels: form?.elements.enabledModels.value,
      apiKey: form?.elements.apiKey.value,
      spinnerVisible: document.querySelector('.state-card .spinner') !== null,
    };
  })()`);
  assert.deepEqual(preservedDraft, {
    sameForm: true,
    displayName: '尚未保存的 Provider',
    baseUrl: 'https://draft.example.com/v1',
    enabledModels: 'draft-model',
    apiKey: 'sk-unsaved-draft',
    spinnerVisible: false,
  });

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
    bodyText: document.body.innerText,
  })`);
  assert.equal(simplifiedProvider.managedVisible, true);
  assert.equal(simplifiedProvider.advancedHidden, true);
  assert.equal(simplifiedProvider.saveDisabled, true);
  assert.equal(simplifiedProvider.bodyText.includes('不需要判断技术选项'), true);
  assert.equal(simplifiedProvider.bodyText.includes('请先测试连接'), true);

  await window.webContents.executeJavaScript(`
    (() => {
      window.confirm = () => true;
      document.getElementById('provider-test-connection').click();
    })()
  `);
  await waitFor(() => writes.some((write) => write.kind === 'connection-test'));
  assert.equal(writes.find((write) => write.kind === 'connection-test').payload.apiKey,
    'sk-renderer-one-shot');
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
  await waitFor(async () => window.webContents.executeJavaScript(
    "document.querySelector('.provider-notice.success') !== null",
  ));
  const publicDom = await window.webContents.executeJavaScript(`({
    apiKeyValue: document.querySelector('[name="apiKey"]').value,
    bodyText: document.body.innerText,
  })`);
  assert.equal(publicDom.apiKeyValue, '');
  assert.equal(publicDom.bodyText.includes('sk-renderer-one-shot'), false);

  await window.webContents.executeJavaScript(`
    (() => {
      const form = document.getElementById('provider-assignment-form');
      form.elements.providerProfileId.value = 'pp_openai';
      form.elements.modelId.value = 'gpt-5';
      form.requestSubmit();
    })()
  `);
  await waitFor(() => writes.some((write) => write.kind === 'assignment'));
  assert.deepEqual(
    writes.find((write) => write.kind === 'assignment').payload,
    {
      scopeKind: 'global',
      scopeId: null,
      role: 'main',
      providerProfileId: 'pp_openai',
      modelId: 'gpt-5',
    },
  );
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

  await app.quit();
}).catch((error) => {
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
      catalogRevision: 4,
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
