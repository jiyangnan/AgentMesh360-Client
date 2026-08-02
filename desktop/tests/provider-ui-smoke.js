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
const profiles = [
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
];
const probes = [];
let providerFailure = null;
let createFailure = null;
let deleteFailure = null;
let nextProfileId = 1;

app.whenReady().then(run).catch(fail);

async function run() {
  registerFixtures();
  const window = await createWindow();

  await window.webContents.executeJavaScript(
    "document.getElementById('nav-providers').click()",
  );
  await waitForDom(window, "document.querySelector('.provider-list-shell') !== null");

  const defaultHierarchy = await window.webContents.executeJavaScript(`({
    listVisible: document.querySelector('.provider-list-shell') !== null,
    profileCount: document.querySelectorAll('[data-edit-profile]').length,
    editorAbsent: document.getElementById('provider-profile-form') === null,
    dialogAbsent: document.querySelector('[role="dialog"]') === null,
    openButtonVisible: document.querySelector('[data-open-provider-editor]') !== null,
  })`);
  assert.deepEqual(defaultHierarchy, {
    listVisible: true,
    profileCount: 1,
    editorAbsent: true,
    dialogAbsent: true,
    openButtonVisible: true,
  });

  await assertProviderTypography(window);
  await assertTechnicalChecksAreProgressivelyDisclosed(window);

  await openProviderEditor(window);
  await waitForDom(
    window,
    "document.activeElement?.matches('[data-close-provider-editor]') === true",
  );
  const providerSelectSurface = await window.webContents.executeJavaScript(`({
    nativeCount: document.querySelectorAll('#provider-profile-form select').length,
    hiddenNativeCount: document.querySelectorAll(
      '#provider-profile-form select.app-select-native[tabindex="-1"]',
    ).length,
    comboboxCount: document.querySelectorAll(
      '#provider-profile-form button[role="combobox"]',
    ).length,
  })`);
  assert.deepEqual(providerSelectSurface, {
    nativeCount: 4,
    hiddenNativeCount: 4,
    comboboxCount: 4,
  });
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-select-name=\"presetId\"]').click()",
  );
  await waitForDom(
    window,
    "document.querySelector('.app-select-menu[data-open=\"true\"]') !== null",
  );
  const openMenu = await window.webContents.executeJavaScript(`(() => {
    const menu = document.querySelector('.app-select-menu[data-open="true"]');
    const rect = menu.getBoundingClientRect();
    return {
      expanded: document.querySelector('[data-select-name="presetId"]')
        .getAttribute('aria-expanded'),
      portaled: menu.closest('.provider-editor-dialog') === null,
      officialGroup: [...menu.querySelectorAll('.app-select-group-label')]
        .some((label) => label.innerText.startsWith('官方')),
      optionCount: menu.querySelectorAll('[role="option"]').length,
      insideViewport: rect.left >= 0 && rect.top >= 0
        && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight,
    };
  })()`);
  assert.deepEqual(openMenu, {
    expanded: 'true',
    portaled: true,
    officialGroup: true,
    optionCount: 12,
    insideViewport: true,
  });
  await window.webContents.executeJavaScript(`
    document.querySelector('[data-select-name="presetId"]').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
  `);
  await waitForDom(
    window,
    "document.querySelector('.app-select-menu[data-open=\"true\"]') === null"
      + " && document.querySelector('.provider-editor-dialog') !== null",
  );
  await window.webContents.executeJavaScript(`
    document.querySelector('.provider-editor-dialog').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
  `);
  await waitForDom(window, "document.querySelector('[role=\"dialog\"]') === null");
  await waitForDom(
    window,
    "document.activeElement?.matches('[data-open-provider-editor]') === true",
  );
  await openProviderEditor(window);
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
  await waitForDom(
    window,
    "document.querySelector('[data-ready-account-name]')?.textContent === 'Ferdinand Revalidated'",
  );
  const preservedDuringRevalidation = await readProviderForm(window);
  assert.deepEqual(preservedDuringRevalidation, {
    sameForm: true,
    presetId: '__custom__',
    displayName: '尚未保存的 Provider',
    baseUrl: 'https://draft.example.com/v1',
    manualModel: 'draft-model',
    apiKey: 'sk-unsaved-draft',
    secretInMarkup: false,
  });

  await window.webContents.executeJavaScript(`
    (() => {
      document.getElementById('nav-agents').click();
      document.getElementById('nav-providers').click();
    })()
  `);
  await waitForDom(
    window,
    "document.querySelector('.provider-editor-dialog[role=\"dialog\"]') !== null",
  );
  assert.deepEqual(await readProviderForm(window), {
    sameForm: false,
    presetId: '__custom__',
    displayName: '尚未保存的 Provider',
    baseUrl: 'https://draft.example.com/v1',
    manualModel: 'draft-model',
    apiKey: 'sk-unsaved-draft',
    secretInMarkup: false,
  });

  await window.webContents.executeJavaScript(
    "document.querySelector('[data-close-provider-editor]').click()",
  );
  await waitForDom(window, "document.querySelector('[role=\"dialog\"]') === null");
  await openProviderEditor(window);
  assert.equal(
    await window.webContents.executeJavaScript(
      "document.getElementById('provider-profile-form').elements.displayName.value",
    ),
    '尚未保存的 Provider',
  );
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-discard-provider-draft]').click()",
  );
  await waitForDom(window, "document.querySelector('[role=\"dialog\"]') === null");
  await openProviderEditor(window);
  assert.deepEqual(
    await window.webContents.executeJavaScript(`(() => {
      const form = document.getElementById('provider-profile-form');
      return {
        presetId: form.elements.presetId.value,
        displayName: form.elements.displayName.value,
        apiKey: form.elements.apiKey.value,
      };
    })()`),
    { presetId: '', displayName: '', apiKey: '' },
  );

  await window.webContents.executeJavaScript(`
    (() => {
      const form = document.getElementById('provider-profile-form');
      form.elements.presetId.value = '__custom__';
      form.elements.presetId.dispatchEvent(new Event('change', { bubbles: true }));
      form.elements.displayName.value = '账号 A 草稿';
      form.elements.apiKey.value = 'sk-account-a-draft';
    })()
  `);
  window.webContents.send('identity:state', {
    ...readyState(),
    account: { id: 8, email: 'other@example.com', displayName: 'Other Account' },
    validationRevision: 1,
  });
  await waitForDom(
    window,
    "document.querySelector('[data-ready-account-name]')?.textContent === 'Other Account'",
  );
  await window.webContents.executeJavaScript(
    "document.getElementById('nav-providers').click()",
  );
  await waitForDom(window, "document.querySelector('.provider-list-shell') !== null");
  assert.equal(
    await window.webContents.executeJavaScript(
      "document.querySelector('[role=\"dialog\"]') === null",
    ),
    true,
  );
  await openProviderEditor(window);
  assert.deepEqual(
    await window.webContents.executeJavaScript(`(() => {
      const form = document.getElementById('provider-profile-form');
      return {
        presetId: form.elements.presetId.value,
        displayName: form.elements.displayName.value,
        apiKey: form.elements.apiKey.value,
        secretInMarkup: document.documentElement.innerHTML.includes('sk-account-a-draft'),
      };
    })()`),
    { presetId: '', displayName: '', apiKey: '', secretInMarkup: false },
  );

  window.webContents.send('identity:state', {
    ...readyState(),
    validationRevision: 3,
  });
  await waitForDom(
    window,
    "document.querySelector('[data-ready-account-name]')?.textContent === 'Ferdinand'",
  );
  await window.webContents.executeJavaScript(
    "document.getElementById('nav-providers').click()",
  );
  await waitForDom(window, "document.querySelector('.provider-list-shell') !== null");
  await openProviderEditor(window);
  assert.deepEqual(
    await window.webContents.executeJavaScript(`(() => {
      const form = document.getElementById('provider-profile-form');
      return {
        presetId: form.elements.presetId.value,
        displayName: form.elements.displayName.value,
        apiKey: form.elements.apiKey.value,
      };
    })()`),
    { presetId: '', displayName: '', apiKey: '' },
  );

  await configureOfficialProvider(window, {
    displayName: 'OpenAI Production',
    apiKey: 'sk-renderer-one-shot',
    modelId: 'gpt-5',
  });
  createFailure = new Error('fixture create failed');
  await window.webContents.executeJavaScript(
    "document.querySelector('.provider-save-button').click()",
  );
  await waitForDom(
    window,
    "document.querySelector('.provider-editor-dialog[role=\"dialog\"]') !== null"
      + " && document.querySelector('.provider-modal-notice.error') !== null",
  );
  const failedCreateState = await window.webContents.executeJavaScript(`(() => {
    const form = document.getElementById('provider-profile-form');
    return {
      displayName: form.elements.displayName.value,
      selectedModel: form.elements.enabledModels.value,
      connectionPassed: form.dataset.connectionTestPassed,
      saveEnabled: !form.querySelector('.provider-save-button').disabled,
      apiKey: form.elements.apiKey.value,
      secretInMarkup: document.documentElement.innerHTML.includes('sk-renderer-one-shot'),
    };
  })()`);
  assert.deepEqual(failedCreateState, {
    displayName: 'OpenAI Production',
    selectedModel: 'gpt-5',
    connectionPassed: 'true',
    saveEnabled: true,
    apiKey: 'sk-renderer-one-shot',
    secretInMarkup: false,
  });
  createFailure = null;
  const createCountBeforeSave = writes.filter((write) => write.kind === 'create').length;
  const saveWasEnabled = await window.webContents.executeJavaScript(`
    (() => {
      const button = document.querySelector('.provider-save-button');
      const enabled = !button.disabled;
      button.click();
      return enabled;
    })()
  `);
  assert.equal(saveWasEnabled, true);
  await waitFor(
    () => writes.filter((write) => write.kind === 'create').length === createCountBeforeSave + 1,
  );
  const createWrite = writes.filter((write) => write.kind === 'create').at(-1);
  assert.equal(createWrite.payload.apiKey, 'sk-renderer-one-shot');
  assert.equal(createWrite.payload.profile.displayName, 'OpenAI Production');
  assert.deepEqual(createWrite.payload.profile.enabledModels, ['gpt-5']);
  await waitForDom(
    window,
    "document.querySelector('.provider-editor-dialog[role=\"dialog\"]') === null",
  );
  await waitForDom(window, "document.querySelectorAll('[data-edit-profile]').length === 2");
  const createdProfile = profiles.find((profile) => profile.displayName === 'OpenAI Production');
  assert.ok(createdProfile);
  const createdRow = await profileRowSnapshot(window, createdProfile.profileId);
  assert.equal(createdRow.includes('OpenAI Production'), true);
  assert.equal(createdRow.includes('1 个可用模型'), true);
  assert.equal(createdRow.includes('shot'), true);
  const publicDom = await window.webContents.executeJavaScript(`({
    editorAbsent: document.getElementById('provider-profile-form') === null,
    secretInMarkup: document.documentElement.innerHTML.includes('sk-renderer-one-shot'),
    secretInText: document.body.innerText.includes('sk-renderer-one-shot'),
  })`);
  assert.deepEqual(publicDom, {
    editorAbsent: true,
    secretInMarkup: false,
    secretInText: false,
  });

  await window.webContents.executeJavaScript(
    `document.querySelector('[data-edit-profile="${createdProfile.profileId}"]').click()`,
  );
  await waitForDom(
    window,
    "document.querySelector('.provider-editor-dialog[role=\"dialog\"]') !== null",
  );
  assert.deepEqual(
    await window.webContents.executeJavaScript(`(() => {
      const form = document.getElementById('provider-profile-form');
      return {
        displayName: form.elements.displayName.value,
        apiKey: form.elements.apiKey.value,
      };
    })()`),
    { displayName: 'OpenAI Production', apiKey: '' },
  );
  await window.webContents.executeJavaScript(`
    (() => {
      const field = document.getElementById('provider-profile-form').elements.displayName;
      field.value = '尚未保存的编辑';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-close-provider-editor]').click();
    })()
  `);
  await waitForDom(window, "document.querySelector('[role=\"dialog\"]') === null");
  assert.equal(
    (await profileRowSnapshot(window, createdProfile.profileId)).includes('OpenAI Production'),
    true,
  );
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-edit-profile="${createdProfile.profileId}"]').click()`,
  );
  await waitForDom(
    window,
    "document.getElementById('provider-profile-form')?.elements.displayName.value === '尚未保存的编辑'",
  );
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-discard-provider-draft]').click()",
  );
  await waitForDom(window, "document.querySelector('[role=\"dialog\"]') === null");

  await window.webContents.executeJavaScript(
    `document.querySelector('[data-edit-profile="${createdProfile.profileId}"]').click()`,
  );
  await waitForDom(
    window,
    "document.getElementById('provider-profile-form')?.elements.displayName.value === 'OpenAI Production'",
  );
  const updateCountBeforeSave = writes.filter((write) => write.kind === 'update').length;
  const editSaveWasEnabled = await window.webContents.executeJavaScript(`
    (() => {
      const form = document.getElementById('provider-profile-form');
      form.elements.displayName.value = 'OpenAI Team';
      form.elements.displayName.dispatchEvent(new Event('input', { bubbles: true }));
      const button = form.querySelector('.provider-save-button');
      const enabled = !button.disabled;
      button.click();
      return enabled;
    })()
  `);
  assert.equal(editSaveWasEnabled, true);
  await waitFor(
    () => writes.filter((write) => write.kind === 'update').length === updateCountBeforeSave + 1,
  );
  await waitForDom(window, "document.querySelector('[role=\"dialog\"]') === null");
  assert.equal(
    (await profileRowSnapshot(window, createdProfile.profileId)).includes('OpenAI Team'),
    true,
  );
  assert.equal(
    writes.some((write) => write.kind === 'replace-secret'
      && write.payload.profileId === createdProfile.profileId),
    false,
  );

  const deleteCountBeforeCancel = writes.filter((write) => write.kind === 'delete').length;
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-delete-profile=\"pp_openai\"]').click()",
  );
  await waitForDom(window, "document.querySelector('.provider-delete-dialog') !== null");
  const deleteImpact = await window.webContents.executeJavaScript(
    "document.querySelector('.provider-delete-dialog').innerText",
  );
  assert.equal(deleteImpact.includes('Job Agent'), true);
  assert.equal(deleteImpact.includes('gpt-5'), true);
  assert.equal(deleteImpact.includes('已有对话历史不会删除'), true);
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-cancel-provider-delete]').click()",
  );
  await waitForDom(window, "document.querySelector('.provider-delete-dialog') === null");
  assert.equal(
    writes.filter((write) => write.kind === 'delete').length,
    deleteCountBeforeCancel,
  );
  assert.equal(profiles.some((profile) => profile.profileId === 'pp_openai'), true);

  await window.webContents.executeJavaScript(
    "document.querySelector('[data-delete-profile=\"pp_openai\"]').click()",
  );
  await waitForDom(window, "document.querySelector('.provider-delete-dialog') !== null");
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-confirm-provider-delete]').click()",
  );
  await waitFor(
    () => writes.filter((write) => write.kind === 'delete').length === deleteCountBeforeCancel + 1,
  );
  await waitForDom(window, "document.querySelector('.provider-delete-dialog') === null");
  await waitForDom(window, "document.querySelectorAll('[data-edit-profile]').length === 1");
  assert.equal(
    await window.webContents.executeJavaScript(
      "document.querySelector('[data-edit-profile=\"pp_openai\"]') === null",
    ),
    true,
  );

  await assertProbeActions(window, createdProfile.profileId);

  deleteFailure = new Error('fixture delete failed');
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-delete-profile="${createdProfile.profileId}"]').click()`,
  );
  await waitForDom(window, "document.querySelector('.provider-delete-dialog') !== null");
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-confirm-provider-delete]').click()",
  );
  await waitForDom(
    window,
    "document.querySelector('.provider-notice.error') !== null"
      + ` && document.querySelector('[data-edit-profile="${createdProfile.profileId}"]') !== null`,
  );
  deleteFailure = null;
  await window.webContents.executeJavaScript(
    `document.querySelector('[data-delete-profile="${createdProfile.profileId}"]').click()`,
  );
  await waitForDom(window, "document.querySelector('.provider-delete-dialog') !== null");
  const safeDeleteImpact = await window.webContents.executeJavaScript(
    "document.querySelector('.provider-delete-dialog').innerText",
  );
  assert.equal(safeDeleteImpact.includes('当前没有 Agent 使用这个供应商'), true);
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-confirm-provider-delete]').click()",
  );
  await waitForDom(window, "document.querySelector('[data-provider-count=\"0\"]') !== null");
  const emptyState = await window.webContents.executeJavaScript(`({
    body: document.querySelector('.empty-provider')?.innerText || '',
    profileCount: document.querySelectorAll('[data-edit-profile]').length,
    editorAbsent: document.getElementById('provider-profile-form') === null,
  })`);
  assert.equal(emptyState.body.includes('还没有模型供应商'), true);
  assert.equal(emptyState.body.includes('配置第一个供应商'), true);
  assert.equal(emptyState.profileCount, 0);
  assert.equal(emptyState.editorAbsent, true);

  providerFailure = new Error(
    "Error invoking remote method 'provider:get-snapshot': HostRequestError: Authentication required",
  );
  const errorWindow = await createWindow();
  await errorWindow.webContents.executeJavaScript(
    "document.getElementById('nav-providers').click()",
  );
  await waitForDom(errorWindow, "document.querySelector('.retry-providers') !== null");
  const errorText = await errorWindow.webContents.executeJavaScript('document.body.innerText');
  assert.equal(errorText.includes('本地身份正在恢复，请稍后重试。'), true);
  assert.equal(errorText.includes('provider:get-snapshot'), false);
  assert.equal(errorText.includes('HostRequestError'), false);
  providerFailure = null;
  await errorWindow.webContents.executeJavaScript(
    "document.querySelector('.retry-providers').click()",
  );
  await waitForDom(errorWindow, "document.querySelector('.provider-list-shell') !== null");
  assert.equal(
    await errorWindow.webContents.executeJavaScript(
      "document.querySelector('[role=\"dialog\"]') === null",
    ),
    true,
  );

  errorWindow.destroy();
  window.destroy();
  fs.rmSync(userData, { recursive: true, force: true });
  app.exit(0);
}

function registerFixtures() {
  ipcMain.handle('identity:get-state', () => readyState());
  ipcMain.handle('conversation:get-snapshot', () => ({ phase: 'idle' }));
  ipcMain.handle('agent:get-model-overview', () => ({
    agents: readyState().agents.map((agent) => ({
      agentId: agent.agentId,
      providerProfileId: 'pp_openai',
      providerDisplayName: 'Personal OpenAI',
      modelId: 'gpt-5',
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
    if (createFailure) throw createFailure;
    const stored = {
      profileId: `pp_created_${nextProfileId++}`,
      ...payload.profile,
      credentialConfigured: true,
      credentialLastFour: payload.apiKey.slice(-4),
    };
    profiles.push(stored);
    writes.push({ kind: 'create', payload });
    return { profile: { ...stored } };
  });
  ipcMain.handle('provider:update-profile', (_event, payload) => {
    const index = profiles.findIndex((profile) => profile.profileId === payload.profileId);
    assert.notEqual(index, -1);
    profiles[index] = {
      ...profiles[index],
      ...payload.profile,
      profileId: payload.profileId,
    };
    writes.push({ kind: 'update', payload });
    return { profile: { ...profiles[index] } };
  });
  ipcMain.handle('provider:replace-secret', (_event, payload) => {
    const profile = profiles.find((item) => item.profileId === payload.profileId);
    assert.ok(profile);
    profile.credentialConfigured = true;
    profile.credentialLastFour = payload.apiKey.slice(-4);
    writes.push({ kind: 'replace-secret', payload });
    return { profile: { ...profile } };
  });
  ipcMain.handle('provider:delete-profile', (_event, profileId) => {
    if (deleteFailure) throw deleteFailure;
    const index = profiles.findIndex((profile) => profile.profileId === profileId);
    assert.notEqual(index, -1);
    profiles.splice(index, 1);
    writes.push({ kind: 'delete', profileId });
    return { deleted: true };
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
    const probe = {
      probeId: `probe_${writes.length}`,
      providerProfileId: payload.profileId,
      modelId: payload.modelId,
      level: payload.level,
      status: 'passed',
      networkAttempted: payload.level === 'minimal_inference',
      mayIncurCost: payload.level === 'minimal_inference',
      completedAt: new Date().toISOString(),
    };
    probes.unshift(probe);
    return { probe };
  });
  for (const channel of [
    'identity:login',
    'identity:logout',
    'identity:recheck',
    'agent:activate',
    'external:open-subscription',
    'external:open-registration',
  ]) {
    ipcMain.handle(channel, () => ({}));
  }
}

async function createWindow() {
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
  return window;
}

async function openProviderEditor(window) {
  assert.equal(
    await window.webContents.executeJavaScript(
      "document.getElementById('provider-profile-form') === null",
    ),
    true,
  );
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-open-provider-editor]').click()",
  );
  await waitForDom(
    window,
    "document.querySelector('.provider-editor-dialog[role=\"dialog\"]') !== null"
      + " && document.getElementById('provider-profile-form') !== null",
  );
}

async function readProviderForm(window) {
  return window.webContents.executeJavaScript(`(() => {
    const form = document.getElementById('provider-profile-form');
    return {
      sameForm: form?.dataset.revalidationGuard === 'original-form',
      presetId: form?.elements.presetId.value,
      displayName: form?.elements.displayName.value,
      baseUrl: form?.elements.baseUrl.value,
      manualModel: form?.elements.manualModel.value,
      apiKey: form?.elements.apiKey.value,
      secretInMarkup: document.documentElement.innerHTML.includes('sk-unsaved-draft'),
    };
  })()`);
}

async function configureOfficialProvider(window, { displayName, apiKey, modelId }) {
  const discoveryCount = writes.filter((write) => write.kind === 'model-discovery').length;
  await window.webContents.executeJavaScript(`
    (() => {
      const form = document.getElementById('provider-profile-form');
      form.elements.presetId.value = 'openai';
      form.elements.presetId.dispatchEvent(new Event('change', { bubbles: true }));
      form.elements.displayName.value = ${JSON.stringify(displayName)};
      form.elements.displayName.dispatchEvent(new Event('input', { bubbles: true }));
      form.elements.apiKey.value = ${JSON.stringify(apiKey)};
      form.elements.apiKey.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('provider-discover-models').click();
    })()
  `);
  await waitFor(
    () => writes.filter((write) => write.kind === 'model-discovery').length
      === discoveryCount + 1,
  );
  await waitForDom(
    window,
    "document.getElementById('model-discovery-status').dataset.status === 'passed'",
  );
  const discovered = await window.webContents.executeJavaScript(`(() => {
    const select = document.getElementById('provider-model-select');
    return {
      values: [...select.options].map((option) => option.value).filter(Boolean),
      triggerDisabled: document.querySelector('[data-select-name="enabledModels"]').disabled,
      triggerLabel: document.querySelector('[data-select-name="enabledModels"]')
        .querySelector('.app-select-value').innerText,
      saveDisabled: document.querySelector('.provider-save-button').disabled,
    };
  })()`);
  assert.deepEqual(discovered, {
    values: ['gpt-5', 'gpt-5-mini'],
    triggerDisabled: false,
    triggerLabel: '请选择一个可用模型',
    saveDisabled: true,
  });

  const testCount = writes.filter((write) => write.kind === 'connection-test').length;
  await window.webContents.executeJavaScript(`
    (() => {
      const trigger = document.querySelector('[data-select-name="enabledModels"]');
      trigger.click();
      document.querySelector(
        '.app-select-menu[data-open="true"] [role="option"][data-value=${JSON.stringify(modelId)}]',
      ).click();
      window.confirm = () => true;
      document.getElementById('provider-test-connection').click();
    })()
  `);
  await waitFor(
    () => writes.filter((write) => write.kind === 'connection-test').length === testCount + 1,
  );
  const testWrite = writes.filter((write) => write.kind === 'connection-test').at(-1);
  assert.equal(testWrite.payload.apiKey, apiKey);
  assert.equal(testWrite.payload.modelId, modelId);
  await waitForDom(
    window,
    "document.getElementById('connection-test-status').dataset.status === 'passed'",
  );
}

async function assertTechnicalChecksAreProgressivelyDisclosed(window) {
  const details = await window.webContents.executeJavaScript(`(() => {
    const containers = [...document.querySelectorAll('details.provider-technical-details')];
    const actions = [...document.querySelectorAll('[data-probe-profile]')];
    return {
      detailsCount: containers.length,
      allClosed: containers.every((item) => !item.open),
      everyActionInsideDetails: actions.every(
        (action) => action.closest('details.provider-technical-details') !== null,
      ),
    };
  })()`);
  assert.deepEqual(details, {
    detailsCount: 1,
    allClosed: true,
    everyActionInsideDetails: true,
  });
}

async function assertProviderTypography(window) {
  const typography = await window.webContents.executeJavaScript(`(() => {
    const px = (selector) => Number.parseFloat(getComputedStyle(
      document.querySelector(selector),
    ).fontSize);
    const family = (selector) => getComputedStyle(document.querySelector(selector)).fontFamily;
    return {
      sectionTitle: px('.provider-list-toolbar h2'),
      profileName: px('.profile-copy strong'),
      profileDetail: px('.profile-copy span'),
      profileMeta: px('.profile-copy small'),
      action: px('.row-actions .ghost'),
      rootFamily: family('body'),
      profileFamily: family('.profile-copy strong'),
      metaFamily: family('.profile-copy small'),
      actionFamily: family('.row-actions .ghost'),
    };
  })()`);
  assert.ok(typography.sectionTitle >= 18, `Provider section title is ${typography.sectionTitle}px`);
  assert.ok(typography.profileName >= 15, `Provider name is ${typography.profileName}px`);
  assert.ok(typography.profileDetail >= 13, `Provider detail is ${typography.profileDetail}px`);
  assert.ok(typography.profileMeta >= 12, `Provider metadata is ${typography.profileMeta}px`);
  assert.ok(typography.action >= 13, `Provider action is ${typography.action}px`);
  assert.equal(typography.profileFamily, typography.rootFamily);
  assert.equal(typography.metaFamily, typography.rootFamily);
  assert.equal(typography.actionFamily, typography.rootFamily);
}

async function profileRowSnapshot(window, profileId) {
  return window.webContents.executeJavaScript(`
    document.querySelector('[data-edit-profile="${profileId}"]')
      ?.closest('.profile-row')
      ?.innerText || ''
  `);
}

async function assertProbeActions(window, profileId) {
  const probeCount = writes.filter((write) => write.kind === 'probe').length;
  assert.deepEqual(await window.webContents.executeJavaScript(`(() => {
    const row = document.querySelector('[data-edit-profile="${profileId}"]')
      .closest('.profile-row');
    const select = row.querySelector('.probe-model select');
    const trigger = row.querySelector('.probe-model button[role="combobox"]');
    return {
      nativeHidden: select.classList.contains('app-select-native') && select.tabIndex === -1,
      customTrigger: Boolean(trigger),
      selectedModel: trigger?.querySelector('.app-select-value')?.textContent.trim(),
    };
  })()`), {
    nativeHidden: true,
    customTrigger: true,
    selectedModel: 'gpt-5',
  });
  await window.webContents.executeJavaScript(`
    (() => {
      const row = document.querySelector('[data-edit-profile="${profileId}"]')
        .closest('.profile-row');
      const details = row.querySelector('details.provider-technical-details');
      details.open = true;
      details.querySelector('[data-probe-level="local_validation"]').click();
    })()
  `);
  await waitFor(
    () => writes.filter((write) => write.kind === 'probe').length === probeCount + 1,
  );
  assert.deepEqual(
    writes.filter((write) => write.kind === 'probe').at(-1).payload,
    {
      profileId,
      modelId: 'gpt-5',
      level: 'local_validation',
      confirmPaidInference: false,
    },
  );

  await waitForDom(
    window,
    `document.querySelector('[data-edit-profile="${profileId}"]') !== null`,
  );
  await window.webContents.executeJavaScript(`
    (() => {
      const row = document.querySelector('[data-edit-profile="${profileId}"]')
        .closest('.profile-row');
      const details = row.querySelector('details.provider-technical-details');
      details.open = true;
      window.confirm = () => false;
      details.querySelector('[data-probe-level="minimal_inference"]').click();
    })()
  `);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(
    writes.filter((write) => write.kind === 'probe').length,
    probeCount + 1,
  );

  await window.webContents.executeJavaScript(`
    (() => {
      const row = document.querySelector('[data-edit-profile="${profileId}"]')
        .closest('.profile-row');
      const details = row.querySelector('details.provider-technical-details');
      details.open = true;
      window.confirm = () => true;
      details.querySelector('[data-probe-level="minimal_inference"]').click();
    })()
  `);
  await waitFor(
    () => writes.filter((write) => write.kind === 'probe').length === probeCount + 2,
  );
  assert.equal(
    writes.filter((write) => write.kind === 'probe').at(-1).payload.confirmPaidInference,
    true,
  );
  await waitForDom(
    window,
    "document.body.innerText.includes('模型已真实响应')",
  );
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
    profiles: profiles.map((profile) => ({
      ...profile,
      enabledModels: [...profile.enabledModels],
    })),
    catalog: {
      schemaVersion: 1,
      catalogRevision: 3,
      providers: providerCatalog(),
    },
    assignments: [],
    probes: probes.map((probe) => ({ ...probe })),
  };
}

function providerCatalog() {
  return [
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
  ];
}

async function waitForDom(window, expression, timeoutMs = 3_000) {
  return waitFor(() => window.webContents.executeJavaScript(expression), timeoutMs);
}

async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('provider UI smoke timed out');
}

function fail(error) {
  fs.rmSync(userData, { recursive: true, force: true });
  console.error(error);
  app.exit(1);
}
