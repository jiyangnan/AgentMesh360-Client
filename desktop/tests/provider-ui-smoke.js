'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const writes = [];

app.whenReady().then(async () => {
  ipcMain.handle('identity:get-state', () => readyState());
  ipcMain.handle('provider:get-snapshot', () => providerSnapshot());
  ipcMain.handle('provider:create-profile', (_event, payload) => {
    writes.push({ kind: 'profile', payload });
    return { profile: providerSnapshot().profiles[0] };
  });
  ipcMain.handle('provider:upsert-assignment', (_event, assignment) => {
    writes.push({ kind: 'assignment', payload: assignment });
    return { assignment: providerSnapshot().assignments[0] };
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
      form.elements.presetId.value = 'openai';
      form.elements.presetId.dispatchEvent(new Event('change', { bubbles: true }));
      form.elements.apiKey.value = 'sk-renderer-one-shot';
      form.requestSubmit();
    })()
  `);
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
  };
}
