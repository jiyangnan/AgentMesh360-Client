'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const phase = process.env.AGENTMESH360_VISUAL_STATE || 'signed_out';
const output = process.env.AGENTMESH360_SCREENSHOT || path.join('/tmp', `agentmesh360-${phase}.png`);

app.whenReady().then(async () => {
  ipcMain.handle('identity:get-state', () => fixtureState(phase));
  ipcMain.handle('provider:get-snapshot', () => providerFixture());
  for (const channel of [
    'identity:login',
    'identity:logout',
    'identity:recheck',
    'agent:activate',
    'external:open-subscription',
    'external:open-registration',
    'provider:create-profile',
    'provider:update-profile',
    'provider:replace-secret',
    'provider:delete-profile',
    'provider:upsert-assignment',
    'provider:delete-assignment',
  ]) {
    ipcMain.handle(channel, () => providerFixture());
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
  await new Promise((resolve) => setTimeout(resolve, 180));
  if (phase === 'provider' || phase === 'provider-bottom') {
    await window.webContents.executeJavaScript("document.getElementById('nav-providers').click()");
    await new Promise((resolve) => setTimeout(resolve, 180));
    if (phase === 'provider-bottom') {
      await window.webContents.executeJavaScript("document.querySelector('.workspace-main').scrollTo(0, document.querySelector('.workspace-main').scrollHeight)");
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  const image = await window.webContents.capturePage();
  fs.writeFileSync(output, image.toPNG());
  await app.quit();
}).catch(() => app.exit(1));

function fixtureState(selected) {
  if (selected === 'ready' || selected === 'provider' || selected === 'provider-bottom') {
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
      catalogRevision: 4,
      providers: [
        {
          presetId: 'openai',
          displayName: 'OpenAI',
          protocol: 'openai_responses',
          defaultBaseUrl: 'https://api.openai.com/v1',
          authKind: 'bearer_api_key',
          models: [{ modelId: 'gpt-5' }, { modelId: 'gpt-5-mini' }],
        },
        {
          presetId: 'anthropic',
          displayName: 'Anthropic',
          protocol: 'anthropic_messages',
          defaultBaseUrl: 'https://api.anthropic.com',
          authKind: 'x_api_key',
          models: [{ modelId: 'claude-opus-4-1' }],
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
  };
}
