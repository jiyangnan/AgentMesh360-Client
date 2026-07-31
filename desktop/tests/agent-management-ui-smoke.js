'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const calls = [];
let bindingIssue = null;
let jobBindingMissing = false;
let modelSaveFailure = false;
let deletedProvider = false;
let profilesUnavailable = false;
let customizationConflict = false;
let hostBridgeState = 'connected';
let backgroundDelayMs = 0;
let managementDelayMs = 0;
let modelSaveBarrier = null;
let customizationSaveBarrier = null;
let validationRevision = 1;
let activeAccountId = 7;
let smokeStep = 'startup';
let agentMd = {
  kind: 'agent_md',
  content: '',
  revision: 0,
  customized: false,
};
let userMd = {
  kind: 'user_md',
  content: '',
  revision: 0,
  customized: false,
};

app.whenReady().then(async () => {
  ipcMain.handle('identity:get-state', () => readyState());
  ipcMain.handle('provider:get-snapshot', () => providerSnapshot());
  ipcMain.handle('conversation:get-snapshot', () => ({ phase: 'idle' }));
  ipcMain.handle('conversation:open', (event, agentId) => {
    calls.push(['open-conversation', agentId]);
    const displayName = agentId === 'job-agent'
      ? 'Job Agent'
      : agentId === 'deploy-agent'
        ? 'Deploy Agent'
        : 'LectureCast Agent';
    const snapshot = {
      phase: 'ready',
      agentId,
      displayName,
      messages: [],
      activities: [],
      backgroundTasks: [],
      backgroundStatus: 'ready',
      planEntries: [],
      planStatus: 'ready',
      artifacts: [],
      artifactStatus: 'ready',
      project: null,
      projectStatus: 'ready',
      streaming: false,
      transcriptTruncated: false,
      error: null,
    };
    event.sender.send('conversation:state', snapshot);
    return snapshot;
  });
  ipcMain.handle('agent:get-management-snapshot', async (_event, agentId) => {
    if (managementDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, managementDelayMs));
    }
    return managementSnapshot(agentId);
  });
  ipcMain.handle('agent:get-model-overview', () => modelOverview());
  ipcMain.handle('runtime:get-background-snapshot', async () => {
    if (backgroundDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, backgroundDelayMs));
    }
    return {
      host: { bridgeState: hostBridgeState, mode: 'persistent_leader' },
      loginItem: { supported: true, openAtLogin: true },
    };
  });
  ipcMain.handle('provider:delete-profile', (_event, profileId) => {
    calls.push(['delete-provider', profileId]);
    deletedProvider = true;
    bindingIssue = {
      code: 'provider_unavailable',
      message: '原模型供应商已被删除或不可用，请重新选择。',
    };
    return {};
  });
  ipcMain.handle('agent:save-model', async (_event, request) => {
    const shouldFail = modelSaveFailure;
    const barrier = modelSaveBarrier;
    if (barrier) {
      calls.push(['save-model-pending', request]);
      await barrier.promise;
    }
    if (shouldFail) {
      calls.push(['save-model-failed', request]);
      throw new Error('fixture model save failed');
    }
    calls.push(['save-model', request]);
    bindingIssue = null;
    jobBindingMissing = false;
    return managementSnapshot(request.agentId, request);
  });
  ipcMain.handle('agent:configure-and-activate', (_event, request) => {
    calls.push(['activate', request]);
    return readyState();
  });
  ipcMain.handle('agent:save-customization', async (_event, request) => {
    const shouldConflict = customizationConflict;
    const barrier = customizationSaveBarrier;
    if (barrier) {
      calls.push(['save-customization-pending', request]);
      await barrier.promise;
    }
    if (shouldConflict) {
      customizationConflict = false;
      calls.push(['save-customization-conflict', request]);
      throw new Error('agent customization revision conflict; reload before saving');
    }
    calls.push(['save-customization', request]);
    const updated = {
      kind: request.kind,
      content: request.content,
      revision: request.expectedRevision + 1,
      customized: true,
    };
    if (request.kind === 'agent_md') agentMd = updated;
    else userMd = updated;
    return updated;
  });
  ipcMain.handle('agent:clear-customization', (_event, request) => {
    calls.push(['clear-customization', request]);
    const updated = {
      kind: request.kind,
      content: '',
      revision: request.expectedRevision + 1,
      customized: false,
    };
    if (request.kind === 'agent_md') agentMd = updated;
    else userMd = updated;
    return updated;
  });
  for (const channel of [
    'identity:login',
    'identity:logout',
    'identity:recheck',
    'agent:activate',
    'conversation:send',
    'conversation:respond-permission',
    'conversation:close',
    'external:open-subscription',
    'external:open-registration',
  ]) {
    ipcMain.handle(channel, () => ({}));
  }

  const window = new BrowserWindow({
    width: 1280,
    height: 850,
    show: false,
    backgroundColor: '#090d16',
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error') process.stderr.write(`Renderer: ${event.message}\n`);
  });
  smokeStep = 'load renderer';
  await window.loadFile(path.join(__dirname, '..', 'src', 'ui', 'index.html'));
  smokeStep = 'wait for Agent list';
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('[data-manage-agent=\"job-agent\"]') !== null",
  ));
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('[data-manage-agent=\"job-agent\"]')?.closest('.agent-card')?.querySelector('.agent-model-summary strong')?.innerText.includes('glm-5.2') === true",
  ));

  smokeStep = 'inspect navigation';
  const navigation = await window.webContents.executeJavaScript(`({
    labels: [...document.querySelectorAll('.nav-item')].map((item) => item.innerText.trim()),
    currentConversation: document.getElementById('nav-conversation') !== null,
    packages: document.getElementById('nav-packages') !== null,
    hostStatus: document.querySelector('[data-host-status]')?.innerText,
    jobModel: document.querySelector('[data-manage-agent="job-agent"]')
      ?.closest('.agent-card')?.querySelector('.agent-model-summary strong')?.innerText,
    guide: document.querySelector('.onboarding-strip')?.innerText,
  })`);
  assert.deepEqual({
    ...navigation,
    guide: undefined,
  }, {
    labels: ['Agent', '模型供应商', '设置'],
    currentConversation: false,
    packages: false,
    hostStatus: '已连接 · 点击查看',
    jobModel: '智谱 GLM Coding Plan · glm-5.2',
    guide: undefined,
  });
  assert.equal(navigation.guide.includes('① 添加模型供应商'), true);
  assert.equal(navigation.guide.includes('② 激活 Agent'), true);
  assert.equal(navigation.guide.includes('③ 在 Agent 对话中开始工作'), true);

  smokeStep = 'show Host recovering and attention states';
  backgroundDelayMs = 150;
  hostBridgeState = 'detached';
  validationRevision += 1;
  window.webContents.send('identity:state', readyState());
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('[data-host-status]')?.innerText === '正在恢复 · 点击查看'",
  ));
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('[data-host-status]')?.innerText === '需要处理 · 点击查看'",
  ));
  await window.webContents.executeJavaScript("document.getElementById('sidebar-host').click()");
  await waitFor(() => window.webContents.executeJavaScript(
    "document.body.innerText.includes('桌面已断开')",
  ));
  assert.deepEqual(await window.webContents.executeJavaScript(
    "[...document.querySelectorAll('[data-settings-tab]')].map((item) => item.innerText.trim())",
  ), ['账号与订阅', '后台运行', '使用指南', '高级诊断']);
  hostBridgeState = 'connected';
  backgroundDelayMs = 0;
  validationRevision += 1;
  window.webContents.send('identity:state', readyState());
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('[data-host-status]')?.innerText === '已连接 · 点击查看'",
  ));
  await window.webContents.executeJavaScript("document.getElementById('nav-agents').click()");

  smokeStep = 'open inactive Agent';
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-manage-agent=\"lecturecast-agent\"]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.getElementById('agent-model-form') !== null",
  ));
  const activationInitial = await window.webContents.executeJavaScript(`({
    submitDisabled: document.querySelector('#agent-model-form button[type="submit"]').disabled,
    provider: document.querySelector('#agent-model-form [name="providerProfileId"]').value,
    models: [...document.querySelectorAll('#agent-model-form [name="modelId"] option')]
      .map((option) => option.value).filter(Boolean),
  })`);
  assert.deepEqual(activationInitial, {
    submitDisabled: true,
    provider: '',
    models: [],
  });
  const activationPermissions = await window.webContents.executeJavaScript(
    "document.querySelector('.activation-permissions')?.innerText",
  );
  assert.equal(activationPermissions.includes('网络访问'), true);
  assert.equal(activationPermissions.includes('进程执行'), true);
  smokeStep = 'choose inactive Agent provider';
  await window.webContents.executeJavaScript(`
    (() => {
      const form = document.getElementById('agent-model-form');
      form.elements.providerProfileId.value = 'pp_glm';
      form.elements.providerProfileId.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  smokeStep = 'confirm inactive Agent activation';
  await window.webContents.executeJavaScript(`
    (() => {
      const form = document.getElementById('agent-model-form');
      form.elements.modelId.value = 'glm-5.2';
      form.elements.modelId.dispatchEvent(new Event('change', { bubbles: true }));
      form.elements.confirmActivation.checked = true;
      form.elements.confirmActivation.dispatchEvent(new Event('change', { bubbles: true }));
      form.requestSubmit();
    })()
  `);
  await waitFor(() => calls.some(([kind]) => kind === 'activate'));
  assert.deepEqual(calls.find(([kind]) => kind === 'activate')[1], {
    agentId: 'lecturecast-agent',
    providerProfileId: 'pp_glm',
    modelId: 'glm-5.2',
  });

  smokeStep = 'return to Agent list';
  await waitFor(() => window.webContents.executeJavaScript(
    "document.getElementById('nav-agents') !== null",
  ));
  await window.webContents.executeJavaScript("document.getElementById('nav-agents').click()");
  managementDelayMs = 250;
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-manage-agent=\"job-agent\"]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('.conversation-state')?.innerText === '正在加载'",
  ));
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    textareaDisabled: document.querySelector('#conversation-form textarea')?.disabled,
    sendDisabled: document.querySelector('#conversation-form button[type="submit"]')?.disabled,
    falselyConnected: document.querySelector('.conversation-state')?.innerText === '已连接',
  })`), {
    textareaDisabled: true,
    sendDisabled: true,
    falselyConnected: false,
  });
  window.webContents.send('conversation:state', {
    phase: 'ready',
    agentId: 'job-agent',
    displayName: 'Job Agent',
    messages: [{ id: 'stale-ready', role: 'assistant', text: 'stale ready snapshot' }],
    activities: [],
    backgroundTasks: [],
    backgroundStatus: 'ready',
    planEntries: [],
    planStatus: 'ready',
    artifacts: [],
    artifactStatus: 'ready',
    project: null,
    projectStatus: 'ready',
    streaming: false,
    transcriptTruncated: false,
    error: null,
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    state: document.querySelector('.conversation-state')?.innerText,
    textareaDisabled: document.querySelector('#conversation-form textarea')?.disabled,
    sendDisabled: document.querySelector('#conversation-form button[type="submit"]')?.disabled,
    staleTextVisible: document.body.innerText.includes('stale ready snapshot'),
  })`), {
    state: '正在加载',
    textareaDisabled: true,
    sendDisabled: true,
    staleTextVisible: false,
  });
  window.webContents.send('conversation:state', { phase: 'idle' });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    state: document.querySelector('.conversation-state')?.innerText,
    textareaDisabled: document.querySelector('#conversation-form textarea')?.disabled,
    sendDisabled: document.querySelector('#conversation-form button[type="submit"]')?.disabled,
  })`), {
    state: '正在加载',
    textareaDisabled: true,
    sendDisabled: true,
  });
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('.agent-chat-identity h1')?.innerText === 'Job Agent'",
  ));
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('.conversation-state')?.innerText === '已连接'",
  ));
  smokeStep = 'verify conversation keeps settings out of the primary navigation';
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    settingsButton: document.getElementById('agent-settings-button') !== null,
    settingsNavigation: document.querySelector('.agent-settings-nav') !== null,
    settingsTabs: document.querySelectorAll('[data-agent-setting]').length,
    legacyTabs: document.querySelectorAll('[data-agent-tab]').length,
    backToConversation: document.getElementById('back-to-agent-conversation') !== null,
  })`), {
    settingsButton: true,
    settingsNavigation: false,
    settingsTabs: 0,
    legacyTabs: 0,
    backToConversation: false,
  });
  managementDelayMs = 0;
  window.webContents.send('conversation:state', { phase: 'idle' });
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('.conversation-state')?.innerText === '尚未连接'",
  ));
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    textareaDisabled: document.querySelector('#conversation-form textarea')?.disabled,
    sendDisabled: document.querySelector('#conversation-form button[type="submit"]')?.disabled,
  })`), {
    textareaDisabled: true,
    sendDisabled: true,
  });
  await window.webContents.executeJavaScript(
    "document.getElementById('agent-settings-button').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.getElementById('agent-model-form') !== null",
  ));
  const modelForm = await window.webContents.executeJavaScript(`({
    agent: document.querySelector('.agent-settings-header h1')?.innerText,
    modelTag: document.querySelector('#agent-model-form [name="modelId"]').tagName,
    models: [...document.querySelectorAll('#agent-model-form [name="modelId"] option')]
      .map((option) => option.value).filter(Boolean),
    hasFreeText: document.querySelector('#agent-model-form input[name="modelId"]') !== null,
    requiresActivation: document.querySelector('#agent-model-form [name="confirmActivation"]') !== null,
  })`);
  assert.deepEqual(modelForm, {
    agent: 'Job Agent',
    modelTag: 'SELECT',
    models: ['glm-5.2', 'glm-4.7'],
    hasFreeText: false,
    requiresActivation: false,
  });
  if (process.env.AGENTMESH360_SCREENSHOT) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const image = await window.webContents.capturePage();
    fs.writeFileSync(process.env.AGENTMESH360_SCREENSHOT, image.toPNG());
  }
  smokeStep = 'save resident Agent model';
  await window.webContents.executeJavaScript(`
    (() => {
      const form = document.getElementById('agent-model-form');
      form.elements.modelId.value = 'glm-4.7';
      form.elements.modelId.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  assert.equal(await window.webContents.executeJavaScript(
    "document.querySelector('#agent-model-form button[type=\"submit\"]').disabled",
  ), false);
  await window.webContents.executeJavaScript(
    "document.querySelector('#agent-model-form button[type=\"submit\"]').click()",
  );
  await waitFor(() => calls.some(([kind]) => kind === 'save-model'));
  assert.deepEqual(calls.find(([kind]) => kind === 'save-model')[1], {
    agentId: 'job-agent',
    providerProfileId: 'pp_glm',
    modelId: 'glm-4.7',
  });

  smokeStep = 'save a real selection for a resident Agent without a binding';
  jobBindingMissing = true;
  bindingIssue = null;
  await window.webContents.executeJavaScript(`
    document.getElementById('nav-agents').click();
    document.querySelector('[data-manage-agent="job-agent"]').click();
  `);
  await waitFor(() => window.webContents.executeJavaScript(
    "document.getElementById('agent-settings-button') !== null",
  ));
  await window.webContents.executeJavaScript(
    "document.getElementById('agent-settings-button').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.getElementById('agent-model-form') !== null",
  ));
  assert.equal(await window.webContents.executeJavaScript(
    "document.querySelector('#agent-model-form button[type=\"submit\"]').disabled",
  ), true);
  await window.webContents.executeJavaScript(`
    (() => {
      const form = document.getElementById('agent-model-form');
      form.elements.providerProfileId.value = 'pp_glm';
      form.elements.providerProfileId.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  await window.webContents.executeJavaScript(`
    (() => {
      const form = document.getElementById('agent-model-form');
      form.elements.modelId.value = 'glm-5.2';
      form.elements.modelId.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  assert.equal(await window.webContents.executeJavaScript(
    "document.querySelector('#agent-model-form button[type=\"submit\"]').disabled",
  ), false);
  assert.equal(await window.webContents.executeJavaScript(
    "document.querySelector('.agent-current-model').innerText.includes('glm-5.2（尚未保存）')",
  ), true);
  assert.equal(await window.webContents.executeJavaScript(
    "document.querySelector('#agent-model-form .provider-notice').innerText.includes('点击下方按钮保存后生效')",
  ), true);
  if (process.env.AGENTMESH360_MODEL_EMPTY_SCREENSHOT) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const image = await window.webContents.capturePage();
    fs.writeFileSync(process.env.AGENTMESH360_MODEL_EMPTY_SCREENSHOT, image.toPNG());
  }
  await window.webContents.executeJavaScript(
    "document.querySelector('#agent-model-form button[type=\"submit\"]').click()",
  );
  await waitFor(() => calls.filter(([kind]) => kind === 'save-model').length === 2);
  assert.deepEqual(calls.filter(([kind]) => kind === 'save-model')[1][1], {
    agentId: 'job-agent',
    providerProfileId: 'pp_glm',
    modelId: 'glm-5.2',
  });
  smokeStep = 'open the resident conversation immediately after first model save';
  await window.webContents.executeJavaScript(
    "document.getElementById('back-to-agent-conversation').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('.conversation-state')?.innerText === '已连接'",
  ));
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    textareaDisabled: document.querySelector('#conversation-form textarea')?.disabled,
    sendDisabled: document.querySelector('#conversation-form button[type="submit"]')?.disabled,
    hasError: document.querySelector('.conversation-error') !== null,
  })`), {
    textareaDisabled: false,
    sendDisabled: false,
    hasError: false,
  });
  await window.webContents.executeJavaScript(
    "document.getElementById('agent-settings-button').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.getElementById('agent-model-form') !== null",
  ));

  smokeStep = 'preserve the resident model selection when save fails';
  modelSaveFailure = true;
  await window.webContents.executeJavaScript(`
    (() => {
      const form = document.getElementById('agent-model-form');
      form.elements.modelId.value = 'glm-4.7';
      form.elements.modelId.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  await window.webContents.executeJavaScript(
    "document.querySelector('#agent-model-form button[type=\"submit\"]').click()",
  );
  await waitFor(() => calls.some(([kind]) => kind === 'save-model-failed'));
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('.provider-notice.error') !== null",
  ));
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    modelId: document.querySelector('#agent-model-form [name="modelId"]').value,
    submitDisabled: document.querySelector('#agent-model-form button[type="submit"]').disabled,
    unsaved: document.querySelector('.agent-current-model').innerText.includes('尚未保存'),
  })`), {
    modelId: 'glm-4.7',
    submitDisabled: false,
    unsaved: true,
  });
  modelSaveFailure = false;
  await window.webContents.executeJavaScript(
    "document.querySelector('#agent-model-form button[type=\"submit\"]').click()",
  );
  await waitFor(() => calls.filter(([kind]) => kind === 'save-model').length === 3);
  assert.deepEqual(calls.filter(([kind]) => kind === 'save-model')[2][1], {
    agentId: 'job-agent',
    providerProfileId: 'pp_glm',
    modelId: 'glm-4.7',
  });

  smokeStep = 'ignore a delayed Job model save after switching to Deploy';
  await window.webContents.executeJavaScript(`
    (() => {
      const form = document.getElementById('agent-model-form');
      form.elements.modelId.value = 'glm-5.2';
      form.elements.modelId.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);
  const delayedModelSave = createBarrier();
  modelSaveBarrier = delayedModelSave;
  await window.webContents.executeJavaScript(
    "document.querySelector('#agent-model-form button[type=\"submit\"]')?.click()",
  );
  await waitFor(() => calls.some(
    ([kind, request]) => kind === 'save-model-pending'
      && request.agentId === 'job-agent'
      && request.modelId === 'glm-5.2',
  ));
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-switch-resident-agent=\"deploy-agent\"]')?.click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('.agent-chat-identity h1')?.innerText === 'Deploy Agent'",
  ));
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('.conversation-state')?.innerText === '已连接'",
  ));
  await window.webContents.executeJavaScript(
    "document.getElementById('agent-settings-button')?.click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.getElementById('agent-model-form') !== null",
  ));
  assert.deepEqual(await currentAgentModelUi(window), {
    title: 'Deploy Agent',
    currentModel: 'Kimi Coding Plan · kimi-k2.5',
    providerId: 'pp_kimi',
    modelId: 'kimi-k2.5',
    models: ['kimi-k2.5'],
    successNotice: null,
    errorNotice: null,
  });
  delayedModelSave.resolve();
  modelSaveBarrier = null;
  await waitFor(() => calls.some(
    ([kind, request]) => kind === 'save-model'
      && request.agentId === 'job-agent'
      && request.modelId === 'glm-5.2',
  ));
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.deepEqual(await currentAgentModelUi(window), {
    title: 'Deploy Agent',
    currentModel: 'Kimi Coding Plan · kimi-k2.5',
    providerId: 'pp_kimi',
    modelId: 'kimi-k2.5',
    models: ['kimi-k2.5'],
    successNotice: null,
    errorNotice: null,
  });
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-switch-resident-agent=\"job-agent\"]')?.click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('.agent-chat-identity h1')?.innerText === 'Job Agent'",
  ));
  await window.webContents.executeJavaScript(
    "document.getElementById('agent-settings-button')?.click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.getElementById('agent-model-form') !== null",
  ));

  smokeStep = 'open behavior editor';
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-agent-setting=\"agent_md\"]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.getElementById('agent-customization-form') !== null",
  ));
  smokeStep = 'preserve behavior draft across tabs';
  await window.webContents.executeJavaScript(`
    (() => {
      const textarea = document.querySelector('#agent-customization-form textarea');
      textarea.value = '先给简短计划，再执行。';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('nav-providers').click();
    })()
  `);
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('.provider-only-column') !== null",
  ));
  await window.webContents.executeJavaScript(`
    document.getElementById('nav-agents').click();
    document.querySelector('[data-manage-agent="job-agent"]').click();
  `);
  await waitFor(() => window.webContents.executeJavaScript(
    "document.getElementById('agent-settings-button') !== null",
  ));
  await window.webContents.executeJavaScript(
    "document.getElementById('agent-settings-button').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('[data-agent-setting=\"agent_md\"]') !== null",
  ));
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-agent-setting=\"agent_md\"]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.getElementById('agent-customization-form') !== null",
  ));
  assert.equal(await window.webContents.executeJavaScript(
    "document.querySelector('#agent-customization-form textarea').value",
  ), '先给简短计划，再执行。');
  smokeStep = 'save behavior overlay';
  await window.webContents.executeJavaScript(
    "document.getElementById('agent-customization-form').requestSubmit()",
  );
  await waitFor(() => calls.some(([kind]) => kind === 'save-customization'));
  assert.deepEqual(calls.find(([kind]) => kind === 'save-customization')[1], {
    agentId: 'job-agent',
    kind: 'agent_md',
    content: '先给简短计划，再执行。',
    expectedRevision: 0,
  });

  smokeStep = 'save and clear user preferences';
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-agent-setting=\"user_md\"]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.getElementById('agent-customization-form') !== null",
  ));
  await window.webContents.executeJavaScript(`
    (() => {
      const form = document.getElementById('agent-customization-form');
      form.elements.content.value = '默认使用中文，状态更新保持简洁。';
      form.elements.content.dispatchEvent(new Event('input', { bubbles: true }));
      form.requestSubmit();
    })()
  `);
  await waitFor(() => calls.some(
    ([kind, request]) => kind === 'save-customization' && request.kind === 'user_md',
  ));
  assert.deepEqual(
    calls.find(
      ([kind, request]) => kind === 'save-customization' && request.kind === 'user_md',
    )[1],
    {
      agentId: 'job-agent',
      kind: 'user_md',
      content: '默认使用中文，状态更新保持简洁。',
      expectedRevision: 0,
    },
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.getElementById('restore-customization')?.disabled === false",
  ));
  await window.webContents.executeJavaScript(
    "document.getElementById('restore-customization').click()",
  );
  await waitFor(() => calls.some(
    ([kind, request]) => kind === 'clear-customization' && request.kind === 'user_md',
  ));

  smokeStep = 'preserve draft on customization revision conflict';
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-agent-setting=\"agent_md\"]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.getElementById('agent-customization-form') !== null",
  ));
  customizationConflict = true;
  await window.webContents.executeJavaScript(`
    (() => {
      const form = document.getElementById('agent-customization-form');
      form.elements.content.value = '发生冲突时也不能丢掉这段草稿。';
      form.elements.content.dispatchEvent(new Event('input', { bubbles: true }));
      form.requestSubmit();
    })()
  `);
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('.customization-conflict') !== null",
  ));
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    preserve: document.querySelector('.preserve-customization-draft')?.innerText,
    discard: document.querySelector('.discard-customization-draft')?.innerText,
    draft: document.querySelector('#agent-customization-form textarea')?.value,
  })`), {
    preserve: '保留我的版本',
    discard: '放弃并重载',
    draft: '发生冲突时也不能丢掉这段草稿。',
  });
  await window.webContents.executeJavaScript(
    "document.querySelector('.preserve-customization-draft').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('#agent-customization-form textarea')?.value === '发生冲突时也不能丢掉这段草稿。'",
  ));

  smokeStep = 'discard a stale customization draft and reload saved content';
  customizationConflict = true;
  await window.webContents.executeJavaScript(
    "document.getElementById('agent-customization-form').requestSubmit()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('.discard-customization-draft') !== null",
  ));
  await window.webContents.executeJavaScript(
    "document.querySelector('.discard-customization-draft').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('#agent-customization-form textarea')?.value === '先给简短计划，再执行。'",
  ));
  assert.equal(await window.webContents.executeJavaScript(
    "document.querySelector('.unsaved-badge') === null",
  ), true);

  smokeStep = 'ignore a delayed Job customization failure after switching to Deploy';
  customizationConflict = true;
  const delayedCustomizationSave = createBarrier();
  customizationSaveBarrier = delayedCustomizationSave;
  await window.webContents.executeJavaScript(`
    (() => {
      const form = document.getElementById('agent-customization-form');
      form.elements.content.value = 'Job Agent 的延迟失败草稿';
      form.elements.content.dispatchEvent(new Event('input', { bubbles: true }));
      form.requestSubmit();
    })()
  `);
  await waitFor(() => calls.some(
    ([kind, request]) => kind === 'save-customization-pending'
      && request.agentId === 'job-agent'
      && request.content === 'Job Agent 的延迟失败草稿',
  ));
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-switch-resident-agent=\"deploy-agent\"]')?.click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('.agent-chat-identity h1')?.innerText === 'Deploy Agent'",
  ));
  await window.webContents.executeJavaScript(
    "document.getElementById('agent-settings-button')?.click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('[data-agent-setting=\"agent_md\"]') !== null",
  ));
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-agent-setting=\"agent_md\"]')?.click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.getElementById('agent-customization-form') !== null",
  ));
  await window.webContents.executeJavaScript(`
    (() => {
      const textarea = document.querySelector('#agent-customization-form textarea');
      textarea.value = '只属于 Deploy Agent 的未保存草稿';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  assert.deepEqual(await currentAgentCustomizationUi(window), {
    title: 'Deploy Agent',
    currentModel: 'Kimi Coding Plan · kimi-k2.5',
    activeSetting: '行为',
    packageName: 'Deploy Agent',
    content: '只属于 Deploy Agent 的未保存草稿',
    successNotice: null,
    errorNotice: null,
    conflict: false,
  });
  delayedCustomizationSave.resolve();
  customizationSaveBarrier = null;
  await waitFor(() => calls.some(
    ([kind, request]) => kind === 'save-customization-conflict'
      && request.agentId === 'job-agent'
      && request.content === 'Job Agent 的延迟失败草稿',
  ));
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.deepEqual(await currentAgentCustomizationUi(window), {
    title: 'Deploy Agent',
    currentModel: 'Kimi Coding Plan · kimi-k2.5',
    activeSetting: '行为',
    packageName: 'Deploy Agent',
    content: '只属于 Deploy Agent 的未保存草稿',
    successNotice: null,
    errorNotice: null,
    conflict: false,
  });
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-switch-resident-agent=\"job-agent\"]')?.click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('.agent-chat-identity h1')?.innerText === 'Job Agent'",
  ));
  await window.webContents.executeJavaScript(
    "document.getElementById('agent-settings-button')?.click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('[data-agent-setting=\"agent_md\"]') !== null",
  ));
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-agent-setting=\"agent_md\"]')?.click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.getElementById('agent-customization-form') !== null",
  ));

  smokeStep = 'lock Agent settings while a turn is running';
  window.webContents.send('conversation:state', {
    phase: 'ready',
    agentId: 'job-agent',
    displayName: 'Job Agent',
    messages: [],
    activities: [],
    backgroundTasks: [],
    planEntries: [],
    artifacts: [],
    streaming: true,
  });
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('#agent-customization-form textarea')?.disabled === true",
  ));
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    submitDisabled: document.querySelector('#agent-customization-form button[type="submit"]')?.disabled,
    modelTabDisabled: document.querySelector('[data-agent-setting="model"]')?.disabled,
    notice: document.body.innerText.includes('当前回答完成后即可修改模型、行为或偏好'),
  })`), {
    submitDisabled: true,
    modelTabDisabled: true,
    notice: true,
  });
  const opensBeforeStreamingSessionReturn = calls.filter(
    ([kind]) => kind === 'open-conversation',
  ).length;
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-agent-session=\"main\"]')?.click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.getElementById('conversation-form') !== null",
  ));
  assert.equal(
    calls.filter(([kind]) => kind === 'open-conversation').length,
    opensBeforeStreamingSessionReturn,
  );
  assert.equal(await window.webContents.executeJavaScript(
    "document.querySelector('.conversation-state')?.innerText",
  ), 'Agent 正在处理');
  window.webContents.send('conversation:state', {
    phase: 'ready',
    agentId: 'job-agent',
    displayName: 'Job Agent',
    messages: [],
    activities: [],
    backgroundTasks: [],
    planEntries: [],
    artifacts: [],
    streaming: false,
  });
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('.conversation-state')?.innerText === '已连接'",
  ));
  await window.webContents.executeJavaScript(
    "document.getElementById('agent-settings-button')?.click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('[data-agent-setting=\"agent_md\"]') !== null",
  ));
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-agent-setting=\"agent_md\"]')?.click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('#agent-customization-form textarea')?.disabled === false",
  ));

  bindingIssue = {
    code: 'provider_unavailable',
    message: '原模型供应商已被删除或不可用，请重新选择。',
  };
  smokeStep = 'open Agent with invalid Provider binding';
  await window.webContents.executeJavaScript("document.getElementById('nav-agents').click()");
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-manage-agent=\"job-agent\"]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.getElementById('conversation-fix-model') !== null",
  ));
  const blockedConversation = await window.webContents.executeJavaScript(`({
    textareaDisabled: document.querySelector('#conversation-form textarea').disabled,
    sendDisabled: document.querySelector('#conversation-form button[type="submit"]').disabled,
    message: document.querySelector('.model-binding-error').innerText,
  })`);
  assert.equal(blockedConversation.textareaDisabled, true);
  assert.equal(blockedConversation.sendDisabled, true);
  assert.equal(blockedConversation.message.includes('重新选择'), true);
  smokeStep = 'ignore stale conversation event from another Agent';
  window.webContents.send('conversation:state', {
    phase: 'ready',
    agentId: 'lecturecast-agent',
    displayName: 'LectureCast Agent',
    messages: [{ id: 'stale', role: 'assistant', text: '不应显示的旧 Agent 内容' }],
    streaming: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await window.webContents.executeJavaScript(
    "document.body.innerText.includes('不应显示的旧 Agent 内容')",
  ), false);
  await window.webContents.executeJavaScript(
    "document.getElementById('conversation-fix-model').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.getElementById('agent-model-form') !== null",
  ));

  smokeStep = 'verify Provider page boundary';
  await window.webContents.executeJavaScript("document.getElementById('nav-providers').click()");
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('.provider-only-column') !== null",
  ));
  const providerBoundary = await window.webContents.executeJavaScript(`({
    assignment: document.getElementById('provider-assignment-form') !== null,
    role: document.body.innerText.includes('分配模型角色'),
    copy: document.body.innerText.includes('具体 Agent 使用哪个模型'),
  })`);
  assert.deepEqual(providerBoundary, {
    assignment: false,
    role: false,
    copy: true,
  });
  smokeStep = 'show impacted Agents before Provider deletion';
  const deletionCountBeforeCancel = calls.filter(([kind]) => kind === 'delete-provider').length;
  await window.webContents.executeJavaScript(
    'document.querySelector(\'[data-delete-profile="pp_glm"]\').click()',
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('.provider-delete-dialog') !== null",
  ));
  const deletionImpact = await window.webContents.executeJavaScript(
    "document.querySelector('.provider-delete-dialog').innerText",
  );
  assert.equal(deletionImpact.includes('Job Agent'), true);
  assert.equal(deletionImpact.includes('glm-5.2'), true);
  assert.equal(deletionImpact.includes('已有对话历史不会删除'), true);
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-cancel-provider-delete]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('.provider-delete-dialog') === null",
  ));
  assert.equal(
    calls.filter(([kind]) => kind === 'delete-provider').length,
    deletionCountBeforeCancel,
  );

  smokeStep = 'confirm Provider deletion and expose invalid Agent';
  await window.webContents.executeJavaScript(
    'document.querySelector(\'[data-delete-profile="pp_glm"]\').click()',
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('.provider-delete-dialog') !== null",
  ));
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-confirm-provider-delete]').click()",
  );
  await waitFor(() => calls.some(([kind]) => kind === 'delete-provider'));
  await window.webContents.executeJavaScript("document.getElementById('nav-agents').click()");
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('.agent-model-alert')?.innerText.includes('重新选择') === true",
  ));
  assert.equal(await window.webContents.executeJavaScript(
    "document.querySelector('[data-manage-agent=\"job-agent\"]')?.closest('.agent-card')?.innerText.includes('供应商不可用 · glm-5.2')",
  ), true);

  smokeStep = 'preselect the only remaining Provider without auto activation';
  const activationCountBeforeSingleProfile = calls.filter(([kind]) => kind === 'activate').length;
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-manage-agent=\"lecturecast-agent\"]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.getElementById('agent-model-form') !== null",
  ));
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    provider: document.querySelector('#agent-model-form [name="providerProfileId"]').value,
    modelDisabled: document.querySelector('#agent-model-form [name="modelId"]').disabled,
    submitDisabled: document.querySelector('#agent-model-form button[type="submit"]').disabled,
  })`), {
    provider: 'pp_kimi',
    modelDisabled: false,
    submitDisabled: true,
  });
  await window.webContents.executeJavaScript("document.getElementById('back-to-agents').click()");
  assert.equal(
    calls.filter(([kind]) => kind === 'activate').length,
    activationCountBeforeSingleProfile,
  );

  smokeStep = 'route zero-Provider activation to Provider settings';
  profilesUnavailable = true;
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-manage-agent=\"lecturecast-agent\"]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.getElementById('agent-go-providers') !== null",
  ));
  assert.equal(await window.webContents.executeJavaScript(
    "document.getElementById('agent-model-form') === null",
  ), true);
  await window.webContents.executeJavaScript("document.getElementById('agent-go-providers').click()");
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('.provider-only-column') !== null",
  ));
  assert.equal(
    calls.filter(([kind]) => kind === 'activate').length,
    activationCountBeforeSingleProfile,
  );

  smokeStep = 'clear customization drafts on account switch';
  profilesUnavailable = false;
  await window.webContents.executeJavaScript(`
    document.getElementById('nav-agents').click();
    document.querySelector('[data-manage-agent="job-agent"]').click();
  `);
  await waitFor(() => window.webContents.executeJavaScript(
    "document.getElementById('agent-settings-button') !== null",
  ));
  await window.webContents.executeJavaScript(
    "document.getElementById('agent-settings-button').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('[data-agent-setting=\"agent_md\"]') !== null",
  ));
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-agent-setting=\"agent_md\"]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.getElementById('agent-customization-form') !== null",
  ));
  await window.webContents.executeJavaScript(`
    (() => {
      const textarea = document.querySelector('#agent-customization-form textarea');
      textarea.value = '只属于第一个账号的未保存草稿';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  activeAccountId = 8;
  validationRevision += 1;
  window.webContents.send('identity:state', readyState());
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('[data-manage-agent=\"job-agent\"]') !== null",
  ));
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-manage-agent=\"job-agent\"]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.getElementById('agent-settings-button') !== null",
  ));
  await window.webContents.executeJavaScript(
    "document.getElementById('agent-settings-button').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('[data-agent-setting=\"agent_md\"]') !== null",
  ));
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-agent-setting=\"agent_md\"]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.getElementById('agent-customization-form') !== null",
  ));
  assert.equal(await window.webContents.executeJavaScript(
    "document.querySelector('#agent-customization-form textarea').value",
  ), '先给简短计划，再执行。');

  await app.quit();
}).catch((error) => {
  process.stderr.write(`Agent management smoke failed at ${smokeStep}\n${error.stack || error}\n`);
  app.exit(1);
});

function readyState() {
  return {
    phase: 'ready',
    account: {
      id: activeAccountId,
      email: `ferdinand+${activeAccountId}@example.com`,
      displayName: 'Ferdinand',
    },
    subscription: { status: 'active', plan: 'Pro', periodEnd: '2026-08-21 00:00:00' },
    credits: { balance: 1280 },
    access: { canEnterClient: true, reason: 'subscription_active' },
    validationRevision,
    agents: [
      {
        agentId: 'job-agent',
        displayName: 'Job Agent',
        description: '持续理解你的岗位目标、求职材料和当前进度。',
        version: '1.0.0',
        desiredState: 'running',
        runtimeState: 'resident',
      },
      {
        agentId: 'lecturecast-agent',
        displayName: 'LectureCast Agent',
        description: '把课程资料转化为可发布的音视频内容。',
        version: '1.0.0',
        desiredState: 'stopped',
        runtimeState: 'available',
      },
      {
        agentId: 'deploy-agent',
        displayName: 'Deploy Agent',
        description: '持续管理发布、部署和验证流程。',
        version: '1.0.0',
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
        profileId: 'pp_glm',
        displayName: '智谱 GLM Coding Plan',
        enabledModels: ['glm-5.2', 'glm-4.7'],
      },
      {
        profileId: 'pp_kimi',
        displayName: 'Kimi Coding Plan',
        enabledModels: ['kimi-k2.5'],
      },
    ].filter((profile) => !deletedProvider || profile.profileId !== 'pp_glm'),
    catalog: { catalogRevision: 2, providers: [] },
    probes: [],
  };
}

function managementSnapshot(agentId, binding = null) {
  const deployBinding = agentId === 'deploy-agent'
    ? {
      scopeKind: 'agent',
      scopeId: agentId,
      role: 'main',
      providerProfileId: 'pp_kimi',
      modelId: 'kimi-k2.5',
    }
    : null;
  const deployAgentMd = {
    kind: 'agent_md',
    content: '部署前先执行预检，并清楚报告验证结果。',
    revision: 3,
    customized: true,
  };
  const deployUserMd = {
    kind: 'user_md',
    content: '部署状态更新使用中文。',
    revision: 2,
    customized: true,
  };
  return {
    agentId,
    profiles: profilesUnavailable ? [] : providerSnapshot().profiles,
    modelBinding: binding
      ? {
        scopeKind: 'agent',
        scopeId: agentId,
        role: 'main',
        providerProfileId: binding.providerProfileId,
        modelId: binding.modelId,
      }
      : agentId === 'job-agent' && !jobBindingMissing
        ? {
          scopeKind: 'agent',
          scopeId: agentId,
          role: 'main',
          providerProfileId: 'pp_glm',
          modelId: 'glm-5.2',
        }
        : deployBinding,
    bindingIssue: agentId === 'job-agent' && !jobBindingMissing
      ? bindingIssue
      : deployBinding
        ? null
        : {
          code: 'model_not_configured',
          message: '这个 Agent 尚未选择模型。',
        },
    inheritedFromLegacyGlobal: false,
    customization: {
      packageName: agentId === 'job-agent'
        ? 'Job Agent'
        : agentId === 'deploy-agent'
          ? 'Deploy Agent'
          : 'LectureCast Agent',
      packageVersion: '1.0.0',
      packageDescription: 'Public package description',
      requestedPermissions: ['network_access', 'process_execution'],
      agentMd: agentId === 'deploy-agent' ? deployAgentMd : agentMd,
      userMd: agentId === 'deploy-agent' ? deployUserMd : userMd,
    },
  };
}

function modelOverview() {
  return {
    agents: readyState().agents.map((agent) => ({
      agentId: agent.agentId,
      providerProfileId: agent.agentId === 'job-agent' && !jobBindingMissing
        ? 'pp_glm'
        : agent.agentId === 'deploy-agent'
          ? 'pp_kimi'
          : null,
      providerDisplayName: agent.agentId === 'job-agent' && !jobBindingMissing && !deletedProvider
        ? '智谱 GLM Coding Plan'
        : agent.agentId === 'deploy-agent'
          ? 'Kimi Coding Plan'
          : null,
      modelId: agent.agentId === 'job-agent' && !jobBindingMissing
        ? 'glm-5.2'
        : agent.agentId === 'deploy-agent'
          ? 'kimi-k2.5'
          : null,
      bindingIssue: agent.agentId === 'job-agent'
        ? (jobBindingMissing
          ? {
            code: 'model_not_configured',
            message: '这个 Agent 尚未选择模型。',
          }
          : (bindingIssue || (deletedProvider ? {
            code: 'provider_unavailable',
            message: '原模型供应商已被删除或不可用，请重新选择。',
          } : null)))
        : agent.agentId === 'deploy-agent'
          ? null
          : {
            code: 'model_not_configured',
            message: '这个 Agent 尚未选择模型。',
          },
      inheritedFromLegacyGlobal: false,
    })),
  };
}

function createBarrier() {
  let resolve;
  const promise = new Promise((release) => {
    resolve = release;
  });
  return { promise, resolve };
}

async function currentAgentModelUi(window) {
  return window.webContents.executeJavaScript(`({
    title: document.querySelector('.agent-settings-header h1')?.innerText || null,
    currentModel: document.querySelector('.agent-current-model')?.innerText || null,
    providerId: document.querySelector('#agent-model-form [name="providerProfileId"]')?.value || null,
    modelId: document.querySelector('#agent-model-form [name="modelId"]')?.value || null,
    models: [...document.querySelectorAll('#agent-model-form [name="modelId"] option')]
      .map((option) => option.value).filter(Boolean),
    successNotice: document.querySelector('.provider-notice.success')?.innerText || null,
    errorNotice: document.querySelector('.provider-notice.error')?.innerText || null,
  })`);
}

async function currentAgentCustomizationUi(window) {
  return window.webContents.executeJavaScript(`({
    title: document.querySelector('.agent-settings-header h1')?.innerText || null,
    currentModel: document.querySelector('.agent-current-model')?.innerText || null,
    activeSetting: document.querySelector('[data-agent-setting].active')?.innerText || null,
    packageName: document.querySelector('.package-public-meta strong')?.innerText || null,
    content: document.querySelector('#agent-customization-form textarea')?.value || null,
    successNotice: document.querySelector('.provider-notice.success')?.innerText || null,
    errorNotice: document.querySelector('.provider-notice.error')?.innerText || null,
    conflict: document.querySelector('.customization-conflict') !== null,
  })`);
}

async function waitFor(predicate, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('等待 Agent 管理 UI 超时');
}
