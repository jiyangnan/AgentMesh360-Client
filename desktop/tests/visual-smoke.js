'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const phase = process.env.AGENTMESH360_VISUAL_STATE || 'signed_out';
const output = process.env.AGENTMESH360_SCREENSHOT || path.join('/tmp', `agentmesh360-${phase}.png`);
const backgroundWrites = [];
const identityLoginWrites = [];
let backgroundEnabled = true;

app.whenReady().then(async () => {
  ipcMain.handle('identity:get-state', () => fixtureState(phase));
  ipcMain.handle('identity:login', (_event, payload) => {
    identityLoginWrites.push(payload);
    return fixtureState(phase);
  });
  ipcMain.handle('conversation:get-snapshot', () => ({ phase: 'idle' }));
  ipcMain.handle('package:get-snapshot', () => packageFixture());
  ipcMain.handle('package:refresh-registry', () => ({
    registry: packageFixture().status.remoteRegistry,
    snapshot: packageFixture(),
  }));
  ipcMain.handle('provider:get-snapshot', () => providerFixture());
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
    'provider:upsert-assignment',
    'provider:delete-assignment',
    'provider:run-probe',
    'provider:test-connection',
    'package:download',
    'package:approve',
    'package:rollback',
    'package:reconcile',
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
    if (phase === 'provider-bottom') {
      await window.webContents.executeJavaScript("document.querySelector('.workspace-main').scrollTo(0, document.querySelector('.workspace-main').scrollHeight)");
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  } else if (phase === 'package' || phase === 'package-ready') {
    await window.webContents.executeJavaScript("document.getElementById('nav-packages').click()");
    await new Promise((resolve) => setTimeout(resolve, 180));
  } else if (phase === 'background') {
    await window.webContents.executeJavaScript("document.getElementById('nav-client').click()");
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  const image = await window.webContents.capturePage();
  fs.writeFileSync(output, image.toPNG());
  if (phase === 'package') {
    const closedControls = await window.webContents.executeJavaScript(`({
      installDisabled: document.querySelector('#package-install-form button[type="submit"]').disabled,
      downloadButtonsDisabled: [...document.querySelectorAll('[data-download-package]')]
        .every((button) => button.disabled),
      refreshDisabled: document.getElementById('refresh-package-registry').disabled,
    })`);
    assert.deepEqual(closedControls, {
      installDisabled: true,
      downloadButtonsDisabled: true,
      refreshDisabled: false,
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
}).catch(() => app.exit(1));

function fixtureState(selected) {
  if (selected === 'ready' || selected === 'provider' || selected === 'provider-bottom' || selected === 'package' || selected === 'package-ready' || selected === 'background') {
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
