'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const phase = process.env.AGENTMESH360_VISUAL_STATE || 'signed_out';
const output = process.env.AGENTMESH360_SCREENSHOT || path.join('/tmp', `agentmesh360-${phase}.png`);
const windowWidth = visualDimension(process.env.AGENTMESH360_VISUAL_WIDTH, 1180);
const windowHeight = visualDimension(process.env.AGENTMESH360_VISUAL_HEIGHT, 760);
const backgroundWrites = [];
const identityLoginWrites = [];
let backgroundEnabled = true;
let conversationSnapshot = { phase: 'idle' };

app.whenReady().then(async () => {
  ipcMain.handle('identity:get-state', () => fixtureState(phase));
  ipcMain.handle('identity:login', (_event, payload) => {
    identityLoginWrites.push(payload);
    return fixtureState(phase);
  });
  ipcMain.handle('conversation:get-snapshot', () => conversationSnapshot);
  ipcMain.handle('conversation:open', (event, agentId) => {
    conversationSnapshot = conversationFixture(agentId);
    event.sender.send('conversation:state', conversationSnapshot);
    return conversationSnapshot;
  });
  ipcMain.handle('package:get-snapshot', () => packageFixture());
  ipcMain.handle('package:refresh-registry', () => ({
    registry: packageFixture().status.remoteRegistry,
    snapshot: packageFixture(),
  }));
  ipcMain.handle('provider:get-snapshot', () => providerFixture());
  ipcMain.handle('agent:get-model-overview', () => modelOverviewFixture());
  ipcMain.handle('agent:get-management-snapshot', (_event, agentId) => (
    agentManagementFixture(agentId)
  ));
  ipcMain.handle('runtime:get-background-snapshot', () => backgroundFixture());
  ipcMain.handle('runtime:set-background-startup', (_event, enabled) => {
    backgroundWrites.push(enabled);
    backgroundEnabled = enabled;
    return backgroundFixture();
  });
  for (const channel of [
    'identity:logout',
    'identity:recheck',
    'agent:activate',
    'external:open-subscription',
    'external:open-registration',
    'provider:create-profile',
    'provider:update-profile',
    'provider:replace-secret',
    'provider:delete-profile',
    'provider:run-probe',
    'provider:test-connection',
    'provider:discover-models',
    'package:download',
    'package:approve',
    'package:rollback',
    'package:reconcile',
  ]) {
    ipcMain.handle(channel, () => providerFixture());
  }
  const window = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
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
  await new Promise((resolve) => setTimeout(resolve, 180));
  if (phase === 'conversation' || phase === 'agent-settings') {
    await waitFor(() => window.webContents.executeJavaScript(
      "document.querySelector('[data-manage-agent=\"job-agent\"]') !== null",
    ));
    await window.webContents.executeJavaScript(
      "document.querySelector('[data-manage-agent=\"job-agent\"]').click()",
    );
    await waitFor(() => window.webContents.executeJavaScript(
      "document.getElementById('conversation-form') !== null",
    ));
    await waitFor(() => window.webContents.executeJavaScript(
      "document.querySelector('.conversation-state')?.textContent.trim() === '已连接'"
        + " && document.querySelectorAll('.conversation-message').length === 2",
    ));
    if (phase === 'agent-settings') {
      await window.webContents.executeJavaScript(
        "document.getElementById('agent-settings-button').click()",
      );
      await waitFor(() => window.webContents.executeJavaScript(
        "document.getElementById('agent-model-form') !== null",
      ));
    }
  } else if (phase === 'provider' || phase === 'provider-bottom') {
    await window.webContents.executeJavaScript("document.getElementById('nav-providers').click()");
    await new Promise((resolve) => setTimeout(resolve, 180));
    if (phase === 'provider-bottom' || process.env.AGENTMESH360_VISUAL_PROVIDER_PRESET) {
      await window.webContents.executeJavaScript(
        "document.querySelector('[data-open-provider-editor]').click()",
      );
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    if (process.env.AGENTMESH360_VISUAL_PROVIDER_PRESET) {
      await window.webContents.executeJavaScript(`
        (() => {
          const select = document.getElementById('provider-preset');
          select.value = ${JSON.stringify(process.env.AGENTMESH360_VISUAL_PROVIDER_PRESET)};
          select.dispatchEvent(new Event('change', { bubbles: true }));
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  } else if (phase === 'package' || phase === 'package-ready') {
    await window.webContents.executeJavaScript("document.getElementById('add-agent').click()");
    await new Promise((resolve) => setTimeout(resolve, 180));
  } else if (phase === 'background') {
    await window.webContents.executeJavaScript(`
      (() => {
        document.getElementById('nav-settings').click();
        document.querySelector('[data-settings-tab="background"]').click();
      })()
    `);
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  if (phase === 'conversation' || phase === 'agent-settings') {
    await new Promise((resolve) => setTimeout(resolve, 220));
  }
  const image = await window.webContents.capturePage();
  fs.writeFileSync(output, image.toPNG());
  if (phase === 'conversation') {
    await assertConversationVisual(window);
  } else if (phase === 'agent-settings') {
    await assertAgentSettingsVisual(window);
  } else if (phase === 'package') {
    const closedControls = await window.webContents.executeJavaScript(`({
      hasInstallForm: document.getElementById('package-install-form') !== null,
      hasDownloadButtons: document.querySelector('[data-download-package]') !== null,
      hasRefreshButton: document.getElementById('refresh-package-registry') !== null,
      explainsClosedState: document.body.innerText.includes('在线添加暂未开放'),
    })`);
    assert.deepEqual(closedControls, {
      hasInstallForm: false,
      hasDownloadButtons: false,
      hasRefreshButton: false,
      explainsClosedState: true,
    });
  } else if (phase === 'background') {
    await window.webContents.executeJavaScript("document.getElementById('toggle-background-startup').click()");
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.deepEqual(backgroundWrites, [false]);
    const body = await window.webContents.executeJavaScript('document.body.innerText');
    assert.equal(body.includes('未开启'), true);
  } else if (phase === 'signed_out') {
    const oauthLabels = await window.webContents.executeJavaScript(
      "[...document.querySelectorAll('[data-oauth-provider]')].map((button) => button.innerText)",
    );
    assert.deepEqual(oauthLabels, ['G使用 Google 登录', 'GH使用 GitHub 登录']);
    await window.webContents.executeJavaScript(
      "document.querySelector('[data-oauth-provider=\"google\"]').click()",
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(identityLoginWrites, [{ provider: 'google' }]);
  }
  await app.quit();
}).catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});

function fixtureState(selected) {
  if (selected === 'ready' || selected === 'provider' || selected === 'provider-bottom' || selected === 'package' || selected === 'package-ready' || selected === 'background' || selected === 'conversation' || selected === 'agent-settings') {
    return {
      phase: 'ready',
      account: { id: 7, email: 'ferdinand@example.com', displayName: 'Ferdinand' },
      subscription: { status: 'active', plan: 'Pro', periodEnd: '2026-08-21 00:00:00' },
      credits: { balance: 1280 },
      access: { canEnterClient: true, reason: 'subscription_active' },
      agents: [
        { agentId: 'job-agent', displayName: 'Job Agent', description: '持续理解你的岗位目标、求职材料和当前进度。', desiredState: 'running', runtimeState: 'resident' },
        { agentId: 'lecturecast-agent', displayName: 'Lecturecast Agent', description: '把课程资料转化为可发布、可校验的音视频内容。', desiredState: 'stopped', runtimeState: 'available' },
        { agentId: 'deploy-agent', displayName: 'Deploy Agent', description: '负责发布前检查、部署执行以及上线后的证据验证。', desiredState: 'running', runtimeState: 'working' },
      ],
      checkedAt: new Date().toISOString(),
    };
  }
  if (selected === 'blocked') {
    return {
      phase: 'blocked',
      account: { id: 7, email: 'ferdinand@example.com', displayName: 'Ferdinand' },
      subscription: { status: 'expired' },
      credits: { balance: 1280 },
      access: { canEnterClient: false, reason: 'subscription_expired' },
    };
  }
  return { phase: 'signed_out' };
}

async function assertAgentWorkspaceBase(window) {
  const metrics = await window.webContents.executeJavaScript(`(() => {
    const workspace = document.querySelector('.workspace');
    const sidebar = document.querySelector('.sidebar');
    const rail = document.querySelector('.agent-workspace-rail');
    const main = document.querySelector('.agent-workspace-main');
    const sidebarRect = sidebar?.getBoundingClientRect();
    const railRect = rail?.getBoundingClientRect();
    const mainRect = main?.getBoundingClientRect();
    return {
      hasWorkspaceLayout: workspace?.classList.contains('agent-workspace-layout') === true,
      hasSidebar: Boolean(sidebar),
      hasRail: Boolean(rail),
      hasMain: Boolean(main),
      gridColumns: workspace
        ? getComputedStyle(workspace).gridTemplateColumns.split(/\\s+/).filter(Boolean).length
        : 0,
      columnsOrdered: Boolean(
        sidebarRect && railRect && mainRect
        && sidebarRect.right <= railRect.left + 1
        && railRect.right <= mainRect.left + 1
      ),
      residentAgentCount: document.querySelectorAll('[data-switch-resident-agent]').length,
      activeResidentAgent: document.querySelector('[data-switch-resident-agent].active')
        ?.dataset.switchResidentAgent,
      sessionCount: document.querySelectorAll('[data-agent-session]').length,
      mainSessionCount: document.querySelectorAll('[data-agent-session="main"]').length,
      activeSession: document.querySelector('[data-agent-session].active')?.dataset.agentSession,
      sessionTitle: document.querySelector('[data-agent-session="main"] strong')
        ?.textContent.trim(),
      legacyTabs: document.querySelectorAll(
        '.agent-tabs, .agent-detail-header, .conversation-back, [data-agent-tab]',
      ).length,
      noDocumentOverflow: document.documentElement.scrollWidth
        <= document.documentElement.clientWidth + 1,
      noWorkspaceOverflow: workspace.scrollWidth <= workspace.clientWidth + 1,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  })()`);
  assert.equal(metrics.hasWorkspaceLayout, true);
  assert.equal(metrics.hasSidebar, true);
  assert.equal(metrics.hasRail, true);
  assert.equal(metrics.hasMain, true);
  assert.equal(metrics.gridColumns, 3);
  assert.equal(metrics.columnsOrdered, true);
  assert.equal(metrics.residentAgentCount, 2);
  assert.equal(metrics.activeResidentAgent, 'job-agent');
  assert.equal(metrics.sessionCount, 1);
  assert.equal(metrics.mainSessionCount, 1);
  assert.equal(metrics.sessionTitle, '主会话');
  assert.equal(metrics.legacyTabs, 0);
  assert.equal(metrics.noDocumentOverflow, true);
  assert.equal(metrics.noWorkspaceOverflow, true);
  assert.equal(metrics.viewportWidth >= 1180, true);
  assert.equal(metrics.viewportHeight >= 700, true);
  return metrics;
}

async function assertConversationVisual(window) {
  const workspaceMetrics = await assertAgentWorkspaceBase(window);
  assert.equal(workspaceMetrics.activeSession, 'main');
  const metrics = await window.webContents.executeJavaScript(`(() => {
    const gear = document.getElementById('agent-settings-button');
    const messageBody = document.querySelector('.conversation-message-body');
    const composer = document.querySelector('#conversation-form textarea');
    const state = document.querySelector('.conversation-state');
    const feed = document.querySelector('.conversation-feed');
    const gearRect = gear?.getBoundingClientRect();
    return {
      hasConversationWorkspace: document.querySelector('.agent-conversation-workspace') !== null,
      hasSettingsWorkspace: document.querySelector('.agent-settings-workspace') !== null,
      settingsTabs: document.querySelectorAll('[data-agent-setting]').length,
      toolbarTitle: document.querySelector('.agent-chat-identity h1')?.textContent.trim(),
      conversationState: document.querySelector('.conversation-state')?.textContent.trim(),
      messageCount: document.querySelectorAll('.conversation-message').length,
      gearLabel: gear?.getAttribute('aria-label'),
      gearWidth: gearRect?.width,
      gearHeight: gearRect?.height,
      messageFont: messageBody ? parseFloat(getComputedStyle(messageBody).fontSize) : 0,
      composerFont: composer ? parseFloat(getComputedStyle(composer).fontSize) : 0,
      stateFont: state ? parseFloat(getComputedStyle(state).fontSize) : 0,
      feedWidth: feed?.getBoundingClientRect().width,
      feedFitsTranscript: feed?.getBoundingClientRect().width
        <= document.querySelector('.conversation-transcript')?.getBoundingClientRect().width,
    };
  })()`);
  assert.equal(metrics.hasConversationWorkspace, true);
  assert.equal(metrics.hasSettingsWorkspace, false);
  assert.equal(metrics.settingsTabs, 0);
  assert.equal(metrics.toolbarTitle, 'Job Agent');
  assert.equal(metrics.conversationState, '已连接');
  assert.equal(metrics.messageCount, 2);
  assert.equal(metrics.gearLabel, '打开 Job Agent 设置');
  assert.equal(metrics.gearWidth, 44);
  assert.equal(metrics.gearHeight, 44);
  assert.equal(metrics.messageFont >= 15, true);
  assert.equal(metrics.composerFont >= 15, true);
  assert.equal(metrics.stateFont >= 12, true);
  assert.equal(metrics.feedWidth <= 900, true);
  assert.equal(metrics.feedFitsTranscript, true);
}

async function assertAgentSettingsVisual(window) {
  await assertAgentWorkspaceBase(window);
  const metrics = await window.webContents.executeJavaScript(`({
    hasSettingsWorkspace: document.querySelector('.agent-settings-workspace') !== null,
    hasConversationWorkspace: document.querySelector('.agent-conversation-workspace') !== null,
    hasConversationForm: document.getElementById('conversation-form') !== null,
    hasBackToConversation: document.getElementById('back-to-agent-conversation') !== null,
    hasToolbarGear: document.getElementById('agent-settings-button') !== null,
    title: document.querySelector('.agent-settings-header h1')?.textContent.trim(),
    labels: Array.from(
      document.querySelectorAll('[data-agent-setting]'),
      (node) => node.textContent.trim(),
    ),
    activeSetting: document.querySelector('[data-agent-setting].active')?.dataset.agentSetting,
    hasModelForm: document.getElementById('agent-model-form') !== null,
  })`);
  assert.equal(metrics.hasSettingsWorkspace, true);
  assert.equal(metrics.hasConversationWorkspace, false);
  assert.equal(metrics.hasConversationForm, false);
  assert.equal(metrics.hasBackToConversation, true);
  assert.equal(metrics.hasToolbarGear, false);
  assert.equal(metrics.title, 'Job Agent');
  assert.deepEqual(metrics.labels, ['模型', '行为', '用户偏好']);
  assert.equal(metrics.activeSetting, 'model');
  assert.equal(metrics.hasModelForm, true);
}

function packageFixture() {
  const remoteReady = phase === 'package-ready';
  return {
    catalog: {
      schemaVersion: 1,
      catalogRevision: 7,
      packages: [
        {
          packageId: 'com.agentmesh360.job-agent',
          version: '0.4.7',
          publisher: 'agentmesh360',
          requestedPermissions: ['local_files', 'network_access', 'process_execution'],
          agent: {
            agentId: 'job-agent',
            displayName: 'Job Agent',
            description: '持续理解岗位目标、求职材料和当前进度。',
          },
        },
        {
          packageId: 'com.agentmesh360.lecturecast-agent',
          version: '0.3.2',
          publisher: 'agentmesh360',
          requestedPermissions: ['local_files', 'network_access'],
          agent: {
            agentId: 'lecturecast-agent',
            displayName: 'Lecturecast Agent',
            description: '把课程资料转化为可发布、可校验的音视频内容。',
          },
        },
        {
          packageId: 'com.agentmesh360.deploy-agent',
          version: '0.2.5',
          publisher: 'agentmesh360',
          requestedPermissions: ['network_access', 'external_mutations'],
          agent: {
            agentId: 'deploy-agent',
            displayName: 'Deploy Agent',
            description: '负责发布前检查、部署执行以及上线后的证据验证。',
          },
        },
      ],
    },
    status: {
      catalogGeneration: 3,
      catalogRevision: 7,
      remoteRegistry: {
        outcome: remoteReady ? 'ready' : 'disabled',
        ...(remoteReady ? {
          cache: {
            trustSequence: 4,
            trustExpiresAt: '2026-08-01T00:00:00Z',
            registryRevision: 9,
            registryExpiresAt: '2026-08-01T00:00:00Z',
            packageCount: 4,
            verifiedAt: '2026-07-26T00:00:00Z',
          },
        } : { reason: 'not_configured' }),
        conditionalRequest: false,
      },
      packages: [
        {
          kind: 'installed_active',
          packageId: 'com.agentmesh360.job-agent',
          agentId: 'job-agent',
          version: '0.4.7',
          slot: 'active',
        },
        {
          kind: 'installed_previous',
          packageId: 'com.agentmesh360.job-agent',
          agentId: 'job-agent',
          version: '0.4.6',
          slot: 'previous',
        },
        {
          kind: 'built_in',
          packageId: 'com.agentmesh360.lecturecast-agent',
          agentId: 'lecturecast-agent',
          version: '0.3.2',
        },
        {
          kind: 'built_in',
          packageId: 'com.agentmesh360.deploy-agent',
          agentId: 'deploy-agent',
          version: '0.2.5',
        },
      ],
    },
    discovery: remoteReady ? {
      outcome: 'ready',
      registryRevision: 9,
      registryExpiresAt: '2026-08-01T00:00:00Z',
      packages: [
        {
          packageId: 'com.agentmesh360.job-agent',
          agentId: 'job-agent',
          version: '0.4.8',
          publisher: 'agentmesh360',
          availability: 'update_available',
          currentVersion: '0.4.7',
        },
        {
          packageId: 'com.agentmesh360.research-agent',
          agentId: 'research-agent',
          version: '1.0.0',
          publisher: 'agentmesh360',
          availability: 'new_agent',
        },
      ],
    } : {
      outcome: 'disabled',
      reason: 'not_configured',
      packages: [],
    },
  };
}

function backgroundFixture() {
  return {
    host: {
      mode: 'persistent_leader',
      ownership: 'grok_leader',
      transport: 'leader_stdio_bridge',
      bridgeState: 'connected',
      socketName: 'host.sock',
    },
    loginItem: {
      supported: true,
      openAtLogin: backgroundEnabled,
      wasOpenedAtLogin: false,
      status: backgroundEnabled ? 'enabled' : 'not-registered',
      reason: null,
    },
  };
}

function modelOverviewFixture() {
  return {
    agents: (fixtureState(phase).agents || []).map((agent) => ({
      agentId: agent.agentId,
      providerProfileId: agent.agentId === 'lecturecast-agent' ? null : 'pp_openai',
      providerDisplayName: agent.agentId === 'lecturecast-agent' ? null : 'Personal OpenAI',
      modelId: agent.agentId === 'lecturecast-agent' ? null : 'gpt-5',
      bindingIssue: agent.agentId === 'lecturecast-agent' ? {
        code: 'model_not_configured',
        message: '这个 Agent 尚未选择模型。',
      } : null,
      inheritedFromLegacyGlobal: false,
    })),
  };
}

function agentManagementFixture(agentId) {
  return {
    agentId,
    profiles: providerFixture().profiles,
    modelBinding: {
      scopeKind: 'agent',
      scopeId: agentId,
      role: 'main',
      providerProfileId: 'pp_openai',
      modelId: 'gpt-5',
    },
    bindingIssue: null,
    inheritedFromLegacyGlobal: false,
    customization: {
      packageName: fixtureState(phase).agents
        .find((agent) => agent.agentId === agentId)?.displayName || agentId,
      packageVersion: '1.0.0',
      packageDescription: '本地视觉验收用 Agent Package。',
      requestedPermissions: ['local_files', 'network_access'],
      agentMd: {
        kind: 'agent_md',
        content: '先给出简短计划，再继续执行。',
        revision: 1,
        customized: true,
      },
      userMd: {
        kind: 'user_md',
        content: '默认使用中文。',
        revision: 1,
        customized: true,
      },
    },
  };
}

function conversationFixture(agentId) {
  const displayName = fixtureState(phase).agents
    .find((agent) => agent.agentId === agentId)?.displayName || agentId;
  return {
    phase: 'ready',
    agentId,
    displayName,
    messages: [
      {
        id: 'visual-message-1',
        role: 'user',
        text: '继续我上次的求职进度。',
      },
      {
        id: 'visual-message-2',
        role: 'assistant',
        text: '好的，上次的岗位筛选和材料进度都还在。我们可以从最新的候选岗位继续。',
      },
    ],
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
    stopReason: 'end_turn',
  };
}

function providerFixture() {
  return {
    profiles: [
      {
        profileId: 'pp_openai',
        presetId: 'openai',
        displayName: 'Personal OpenAI',
        protocol: 'openai_responses',
        baseUrl: 'https://api.openai.com/v1',
        authKind: 'bearer_api_key',
        enabledModels: ['gpt-5', 'gpt-5-mini'],
        credentialConfigured: true,
        credentialLastFour: '7K2M',
      },
      {
        profileId: 'pp_anthropic',
        presetId: 'anthropic',
        displayName: 'Anthropic Work',
        protocol: 'anthropic_messages',
        baseUrl: 'https://api.anthropic.com',
        authKind: 'x_api_key',
        enabledModels: ['claude-opus-4-1'],
        credentialConfigured: true,
        credentialLastFour: '39QX',
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
          models: [{ modelId: 'gpt-5' }, { modelId: 'gpt-5-mini' }],
        },
        {
          presetId: 'anthropic',
          displayName: 'Anthropic',
          classification: 'official',
          protocol: 'anthropic_messages',
          defaultBaseUrl: 'https://api.anthropic.com',
          authKind: 'x_api_key',
          models: [{ modelId: 'claude-opus-4-1' }],
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
      {
        assignmentId: 'ma_job_subagent',
        scopeKind: 'agent',
        scopeId: 'job-agent',
        role: 'subagent',
        providerProfileId: 'pp_anthropic',
        modelId: 'claude-opus-4-1',
      },
    ],
    probes: [
      {
        probeId: 'probe_openai',
        providerProfileId: 'pp_openai',
        modelId: 'gpt-5',
        level: 'minimal_inference',
        status: 'passed',
        networkAttempted: true,
        mayIncurCost: true,
        endpointClassification: 'official',
        completedAt: '2026-07-24T08:35:00.000Z',
      },
      {
        probeId: 'probe_anthropic',
        providerProfileId: 'pp_anthropic',
        modelId: 'claude-opus-4-1',
        level: 'local_validation',
        status: 'passed',
        networkAttempted: false,
        mayIncurCost: false,
        endpointClassification: 'official',
        completedAt: '2026-07-24T08:32:00.000Z',
      },
    ],
  };
}

function visualDimension(rawValue, fallback) {
  if (rawValue === undefined || rawValue === '') return fallback;
  const value = Number(rawValue);
  assert.equal(Number.isInteger(value) && value >= 700 && value <= 4000, true);
  return value;
}

async function waitFor(predicate, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`等待 ${phase} 视觉状态超时`);
}
