'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const PACKAGE_ID = 'com.agentmesh360.job-agent';
const APPROVAL_ID = '019f7c3c-0f0d-7b3e-8f4b-8b95278f3a44';
const writes = [];
let snapshotReads = 0;
let smokeStep = 'startup';
let rollbackCalls = 0;

app.whenReady().then(async () => {
  ipcMain.handle('identity:get-state', () => readyState());
  ipcMain.handle('conversation:get-snapshot', () => ({ phase: 'idle' }));
  ipcMain.handle('agent:get-model-overview', () => ({
    agents: readyState().agents.map((agent) => ({
      agentId: agent.agentId,
      providerProfileId: null,
      providerDisplayName: null,
      modelId: null,
      bindingIssue: {
        code: 'model_not_configured',
        message: '这个 Agent 尚未选择模型。',
      },
      inheritedFromLegacyGlobal: false,
    })),
  }));
  ipcMain.handle('runtime:get-background-snapshot', () => ({
    host: { bridgeState: 'connected', mode: 'persistent_leader' },
    loginItem: { supported: true, openAtLogin: true },
  }));
  ipcMain.handle('provider:get-snapshot', () => ({
    profiles: [],
    catalog: { catalogRevision: 1, providers: [] },
    probes: [],
  }));
  ipcMain.handle('package:get-snapshot', () => {
    snapshotReads += 1;
    return packageSnapshot();
  });
  ipcMain.handle('package:refresh-registry', () => {
    writes.push({ operation: 'refresh' });
    return {
      registry: packageSnapshot().status.remoteRegistry,
      snapshot: packageSnapshot(),
    };
  });
  ipcMain.handle('package:download', (_event, packageId) => {
    writes.push({ operation: 'download', packageId });
    return {
      outcome: 'completed',
      operation: 'download',
      value: {
        status: 'approval_required',
        approval: {
          approvalId: APPROVAL_ID,
          packageId,
          version: '0.4.8',
          addedPermissions: ['process_execution'],
          expiresInSeconds: 600,
        },
      },
    };
  });
  ipcMain.handle('package:approve', (_event, approvalId) => {
    writes.push({ operation: 'approve', approvalId });
    return {
      outcome: 'completed',
      operation: 'approve',
      value: packageReceipt('0.4.8'),
    };
  });
  ipcMain.handle('package:reconcile', (_event, packageId) => {
    writes.push({ operation: 'reconcile', packageId });
    return {
      outcome: 'completed',
      operation: 'reconcile',
      value: packageReceipt('0.4.7'),
    };
  });
  ipcMain.handle('package:rollback', (_event, packageId) => {
    writes.push({ operation: 'rollback', packageId });
    rollbackCalls += 1;
    if (rollbackCalls === 1) {
      return {
        outcome: 'completed',
        operation: 'rollback',
        value: {
          ...packageReceipt('0.4.6'),
          runtimeVisibility: {
            status: 'refresh_pending',
            catalogGeneration: 4,
            catalogRevision: 8,
            issue: {
              code: 'package_registry_invalid',
              summary: 'The local package registry could not be read safely.',
            },
          },
        },
      };
    }
    return {
      outcome: 'unknown',
      operation: 'rollback',
      message: 'Agent Host 连接中断，操作结果未知。请先重新读取状态，不要自动重试。',
    };
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
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error') console.error(`Renderer: ${event.message}`);
  });
  smokeStep = 'load renderer';
  await window.loadFile(path.join(__dirname, '..', 'src', 'ui', 'index.html'));
  smokeStep = 'wait for add Agent action';
  await waitFor(async () => window.webContents.executeJavaScript(
    "document.getElementById('add-agent') !== null",
  ));
  smokeStep = 'open package center';
  await window.webContents.executeJavaScript("document.getElementById('add-agent').click()");
  smokeStep = 'wait for package form';
  await waitFor(async () => window.webContents.executeJavaScript(
    "document.getElementById('package-install-form') !== null",
  ));

  smokeStep = 'inspect initial DOM';
  const initialDom = await window.webContents.executeJavaScript('document.body.innerText');
  for (const forbidden of [
    'private system prompt',
    '/private/skill/path',
    'private-root-key',
    'artifactSha256',
    'https://packages.example/private',
  ]) {
    assert.equal(initialDom.includes(forbidden), false);
  }
  assert.equal(initialDom.includes('Job Agent'), true);
  assert.equal(initialDom.includes('可信缓存可用'), true);
  assert.equal(initialDom.includes('可用更新'), true);
  assert.equal(initialDom.includes('新 Agent'), true);

  smokeStep = 'download discovered package by safe package id';
  await window.webContents.executeJavaScript(`
    document.querySelector(
      '[data-download-package="com.agentmesh360.lecturecast-agent"]'
    ).click()
  `);
  await waitFor(() => writes.some(
    (write) => write.operation === 'download'
      && write.packageId === 'com.agentmesh360.lecturecast-agent',
  ));
  await waitFor(async () => window.webContents.executeJavaScript(
    "document.querySelector('.approve-package') !== null",
  ));
  const discoveryApprovalDom = await window.webContents.executeJavaScript('document.body.innerText');
  assert.equal(discoveryApprovalDom.includes(APPROVAL_ID), false);
  await window.webContents.executeJavaScript(
    "document.querySelector('.cancel-package-approval').click()",
  );

  smokeStep = 'submit package download';
  await window.webContents.executeJavaScript(`
    (() => {
      const form = document.getElementById('package-install-form');
      form.elements.packageId.value = '${PACKAGE_ID}';
      form.requestSubmit();
    })()
  `);
  await waitFor(() => writes.some((write) => write.operation === 'download'));
  assert.deepEqual(
    writes.find((write) => write.operation === 'download' && write.packageId === PACKAGE_ID),
    { operation: 'download', packageId: PACKAGE_ID },
  );
  await waitFor(async () => window.webContents.executeJavaScript(
    "document.querySelector('.approve-package') !== null",
  ));
  const approvalDom = await window.webContents.executeJavaScript('document.body.innerText');
  assert.equal(approvalDom.includes('进程执行'), true);
  assert.equal(approvalDom.includes(APPROVAL_ID), false);

  smokeStep = 'approve package';
  await window.webContents.executeJavaScript("document.querySelector('.approve-package').click()");
  await waitFor(() => writes.some((write) => write.operation === 'approve'));
  assert.deepEqual(
    writes.find((write) => write.operation === 'approve'),
    { operation: 'approve', approvalId: APPROVAL_ID },
  );
  await waitFor(async () => window.webContents.executeJavaScript(
    "document.body.innerText.includes('Runtime Catalog 已可见')",
  ));

  smokeStep = 'reconcile package';
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-reconcile-package]').click()",
  );
  await waitFor(() => writes.some((write) => write.operation === 'reconcile'));
  assert.deepEqual(
    writes.find((write) => write.operation === 'reconcile'),
    { operation: 'reconcile', packageId: PACKAGE_ID },
  );
  await waitFor(async () => window.webContents.executeJavaScript(
    "document.querySelector('[data-rollback-package]') !== null",
  ));

  const readsBeforeUnknown = snapshotReads;
  smokeStep = 'rollback package with refresh pending';
  await window.webContents.executeJavaScript(`
    (() => {
      window.confirm = () => true;
      document.querySelector('[data-rollback-package]').click();
    })()
  `);
  await waitFor(() => rollbackCalls === 1);
  await waitFor(async () => window.webContents.executeJavaScript(
    "document.body.innerText.includes('磁盘回滚已提交') && document.body.innerText.includes('运行时仍使用最后良好目录')",
  ));
  const refreshPendingDom = await window.webContents.executeJavaScript('document.body.innerText');
  assert.equal(refreshPendingDom.includes('已回滚并刷新运行时目录'), false);
  await waitFor(async () => window.webContents.executeJavaScript(
    "document.querySelector('[data-rollback-package]') !== null",
  ));

  const readsBeforeSecondRollback = snapshotReads;
  smokeStep = 'rollback package with unknown outcome';
  await window.webContents.executeJavaScript(`
    (() => {
      window.confirm = () => true;
      document.querySelector('[data-rollback-package]').click();
    })()
  `);
  await waitFor(() => rollbackCalls === 2);
  await waitFor(async () => window.webContents.executeJavaScript(
    "document.querySelector('.package-unknown') !== null",
  ));
  assert.equal(snapshotReads > readsBeforeUnknown, true);
  assert.equal(snapshotReads, readsBeforeSecondRollback);
  assert.equal(
    writes.filter((write) => write.operation === 'rollback').length,
    2,
  );

  smokeStep = 'refresh unknown outcome';
  await window.webContents.executeJavaScript(
    "document.querySelector('.refresh-package-state').click()",
  );
  await waitFor(() => snapshotReads > readsBeforeSecondRollback);
  await waitFor(async () => window.webContents.executeJavaScript(
    "document.querySelector('.package-unknown') === null",
  ));

  smokeStep = 'refresh registry';
  await window.webContents.executeJavaScript(
    "document.getElementById('refresh-package-registry').click()",
  );
  await waitFor(() => writes.some((write) => write.operation === 'refresh'));
  assert.deepEqual(
    writes.find((write) => write.operation === 'refresh'),
    { operation: 'refresh' },
  );

  await app.quit();
}).catch((error) => {
  console.error(`Package UI smoke failed during: ${smokeStep}`);
  console.error(error);
  app.exit(1);
});

async function waitFor(predicate, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Agent Package UI smoke timed out');
}

function readyState() {
  return {
    phase: 'ready',
    account: { id: 7, email: 'ferdinand@example.com', displayName: 'Ferdinand' },
    subscription: { status: 'active', plan: 'Pro' },
    credits: { balance: 0 },
    access: { canEnterClient: true, reason: 'subscription_active' },
    agents: [{
      agentId: 'job-agent',
      displayName: 'Job Agent',
      description: 'Career copilot',
      desiredState: 'running',
      runtimeState: 'resident',
    }],
    checkedAt: new Date().toISOString(),
  };
}

function packageSnapshot() {
  return {
    catalog: {
      schemaVersion: 1,
      catalogRevision: 7,
      packages: [{
        packageId: PACKAGE_ID,
        version: '0.4.7',
        publisher: 'agentmesh360',
        requestedPermissions: ['local_files', 'network_access'],
        agent: {
          agentId: 'job-agent',
          displayName: 'Job Agent',
          description: 'Persistent career copilot',
        },
      }],
    },
    status: {
      catalogGeneration: 3,
      catalogRevision: 7,
      remoteRegistry: {
        outcome: 'ready',
        cache: {
          trustSequence: 4,
          trustExpiresAt: '2026-08-01T00:00:00Z',
          registryRevision: 9,
          registryExpiresAt: '2026-07-29T00:00:00Z',
          packageCount: 3,
          verifiedAt: '2026-07-26T00:00:00Z',
        },
        conditionalRequest: false,
      },
      packages: [
        {
          kind: 'built_in',
          packageId: PACKAGE_ID,
          agentId: 'job-agent',
          version: '0.4.6',
        },
        {
          kind: 'installed_active',
          packageId: PACKAGE_ID,
          agentId: 'job-agent',
          version: '0.4.7',
          slot: 'active',
        },
        {
          kind: 'installed_previous',
          packageId: PACKAGE_ID,
          agentId: 'job-agent',
          version: '0.4.6',
          slot: 'previous',
        },
      ],
    },
    discovery: {
      outcome: 'ready',
      registryRevision: 9,
      registryExpiresAt: '2026-08-01T00:00:00Z',
      packages: [
        {
          packageId: PACKAGE_ID,
          agentId: 'job-agent',
          version: '0.4.8',
          publisher: 'agentmesh360',
          availability: 'update_available',
          currentVersion: '0.4.7',
        },
        {
          packageId: 'com.agentmesh360.lecturecast-agent',
          agentId: 'lecturecast-agent',
          version: '1.0.0',
          publisher: 'agentmesh360',
          availability: 'new_agent',
        },
      ],
    },
  };
}

function packageReceipt(version) {
  return {
    packageId: PACKAGE_ID,
    agentId: 'job-agent',
    version,
    runtimeVisibility: {
      status: 'visible',
      catalogGeneration: 4,
      catalogRevision: 8,
    },
  };
}
