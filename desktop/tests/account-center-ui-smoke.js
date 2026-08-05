'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmesh360-account-center-ui-'));
app.setPath('userData', userData);
app.commandLine.appendSwitch('disable-gpu');

let account = { id: 7, email: 'owner@example.com', displayName: 'Owner Account' };
let providerSnapshotCalls = 0;
let logoutCalls = 0;
let smokeStep = 'startup';
let deferNextProviderSnapshot = null;
let deferNextModelOverview = null;
let modelOverviewCalls = 0;

app.whenReady().then(run).catch(fail);

async function run() {
  registerFixtures();
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
    if (event.level === 'error') process.stderr.write(`Renderer: ${event.message}\n`);
  });
  await window.loadFile(path.join(__dirname, '..', 'src', 'ui', 'index.html'));
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('[data-manage-agent=\"job-agent\"]') !== null",
  ));

  smokeStep = 'verify the quiet primary navigation';
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    labels: [...document.querySelectorAll('.nav-item')].map((item) => item.innerText.trim()),
    directProvider: document.getElementById('nav-providers') !== null,
    directSettings: document.getElementById('nav-settings') !== null,
    accountTag: document.getElementById('open-account-settings')?.tagName,
    accountLabel: document.getElementById('open-account-settings')?.getAttribute('aria-label'),
    directLogout: document.querySelector('.sidebar-account #logout') !== null,
  })`), {
    labels: ['Agent'],
    directProvider: false,
    directSettings: false,
    accountTag: 'BUTTON',
    accountLabel: '打开账户与设置',
    directLogout: false,
  });
  assert.equal(providerSnapshotCalls, 0);

  smokeStep = 'open the account center by keyboard';
  assert.equal(await window.webContents.executeJavaScript(`(() => {
    const button = document.getElementById('open-account-settings');
    button.focus();
    return document.activeElement === button;
  })()`), true);
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('.account-center') !== null",
  ));
  await waitFor(() => window.webContents.executeJavaScript(
    "document.activeElement?.dataset.settingsTab === 'account'",
  ));
  assert.deepEqual(await accountCenterSnapshot(window), {
    heading: '账户与设置',
    labels: ['账号与订阅', '模型供应商', '后台运行', '使用指南', '高级诊断'],
    active: ['account'],
    currentCount: 1,
    accountEntryActive: true,
    accountName: 'Owner Account',
    logout: '退出当前账号',
    providerSnapshotCalls: 0,
  });

  smokeStep = 'refresh visible account metadata without rebuilding the settings center';
  const priorCheckedAt = await window.webContents.executeJavaScript(
    "document.querySelector('[data-settings-checked-at]')?.innerText",
  );
  account = { ...account, displayName: 'Zeta Revalidated' };
  window.webContents.send('identity:state', {
    ...readyState(),
    credits: { balance: 777 },
    checkedAt: '2026-08-05T00:00:00.000Z',
    validationRevision: 2,
  });
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('[data-settings-account-name]')?.textContent === 'Zeta Revalidated'"
      + " && document.querySelector('[data-settings-credits]')?.textContent === '777'"
      + " && document.querySelector('.account-settings-card .account-chip strong')?.textContent === 'Zeta Revalidated'"
      + " && document.querySelector('[data-ready-account-avatar]')?.textContent === 'ZE'"
      + " && document.querySelector('[data-settings-account-avatar]')?.textContent === 'ZE'"
      + " && document.querySelector('[data-settings-card-avatar]')?.textContent === 'ZE'",
  ));
  assert.equal(await window.webContents.executeJavaScript(
    "document.querySelector('[data-settings-checked-at]')?.innerText !== "
      + JSON.stringify(priorCheckedAt),
  ), true);
  assert.equal(await window.webContents.executeJavaScript(
    "document.getElementById('open-account-settings')?.classList.contains('active')",
  ), true);

  smokeStep = 'lazy-load the Provider list inside the account center';
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-settings-tab=\"providers\"]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('.provider-list-shell') !== null",
  ));
  assert.equal(providerSnapshotCalls, 1);
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    active: [...document.querySelectorAll('[data-settings-tab].active')]
      .map((item) => item.dataset.settingsTab),
    providerHeading: document.querySelector('.provider-header h1')?.innerText,
    profileCount: document.querySelectorAll('[data-edit-profile]').length,
    editorClosed: document.getElementById('provider-profile-form') === null,
  })`), {
    active: ['providers'],
    providerHeading: '模型供应商',
    profileCount: 1,
    editorClosed: true,
  });

  smokeStep = 'keep the account center usable across compact viewports';
  for (const [width, height] of [[1180, 760], [1280, 768], [1280, 800], [1440, 900], [720, 760]]) {
    window.setSize(width, height);
    await waitFor(() => window.webContents.executeJavaScript(
      `window.innerWidth === ${width} && window.innerHeight >= ${height - 40}`,
    ));
    const layout = await window.webContents.executeJavaScript(`(() => {
      const main = document.querySelector('.workspace-main');
      const center = document.querySelector('.account-center');
      const menuButton = document.querySelector('[data-settings-tab]');
      const menuLabel = menuButton?.querySelector('strong');
      const menuDescription = menuButton?.querySelector('small');
      const centerRect = center?.getBoundingClientRect();
      return {
        width: window.innerWidth,
        height: window.innerHeight,
        noHorizontalOverflow: main.scrollWidth <= main.clientWidth + 1,
        centerInsideMain: centerRect.left >= main.getBoundingClientRect().left
          && centerRect.right <= main.getBoundingClientRect().right + 1,
        menuHeight: menuButton?.getBoundingClientRect().height,
        labelSize: parseFloat(getComputedStyle(menuLabel).fontSize),
        descriptionSize: parseFloat(getComputedStyle(menuDescription).fontSize),
      };
    })()`);
    assert.equal(layout.width, width);
    assert.equal(layout.height >= height - 40 && layout.height <= height, true);
    assert.equal(layout.noHorizontalOverflow, true);
    assert.equal(layout.centerInsideMain, true);
    assert.equal(layout.menuHeight >= 44, true);
    assert.equal(layout.labelSize >= 13, true);
    assert.equal(layout.descriptionSize >= 12, true);
  }

  smokeStep = 'deep-link Host status to background settings';
  window.setSize(1180, 760);
  await window.webContents.executeJavaScript("document.getElementById('sidebar-host').click()");
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('[data-settings-tab=\"background\"].active') !== null"
      + " && document.body.innerText.includes('后台 Host')",
  ));

  smokeStep = 'return to Agent and reopen the remembered setting';
  await window.webContents.executeJavaScript("document.getElementById('nav-agents').click()");
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('[data-manage-agent=\"job-agent\"]') !== null",
  ));
  await window.webContents.executeJavaScript("document.getElementById('open-account-settings').click()");
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('[data-settings-tab=\"background\"].active') !== null",
  ));

  smokeStep = 'reset the account center safely when the account changes';
  let releaseOldProviderSnapshot;
  deferNextProviderSnapshot = new Promise((resolve) => {
    releaseOldProviderSnapshot = resolve;
  });
  await window.webContents.executeJavaScript('void refreshProviderSnapshot(); true');
  await waitFor(() => providerSnapshotCalls === 2);
  account = { id: 8, email: 'next@example.com', displayName: 'Next Account' };
  window.webContents.send('identity:state', readyState());
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('[data-ready-account-name]')?.textContent === 'Next Account'"
      + " && document.querySelector('.account-center') === null",
  ));
  releaseOldProviderSnapshot();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    phase: providerUi.phase,
    snapshot: providerUi.snapshot,
  })`), { phase: 'idle', snapshot: null });
  assert.equal(await window.webContents.executeJavaScript('settingsTab'), 'account');
  await window.webContents.executeJavaScript("document.getElementById('open-account-settings').click()");
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('[data-settings-tab=\"account\"].active') !== null",
  ));
  assert.equal(await window.webContents.executeJavaScript(
    "document.querySelector('.account-center-identity strong')?.innerText",
  ), 'Next Account');
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-settings-tab=\"providers\"]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('[data-edit-profile=\"pp_next\"]') !== null",
  ));
  assert.equal(providerSnapshotCalls, 3);
  assert.equal(await window.webContents.executeJavaScript(
    "document.querySelector('[data-provider-profile=\"pp_next\"]')?.innerText.includes('Next Provider')",
  ), true);

  smokeStep = 'ignore stale delete preparation after an account switch';
  const priorModelOverviewCalls = modelOverviewCalls;
  let releaseOldModelOverview;
  deferNextModelOverview = new Promise((resolve) => {
    releaseOldModelOverview = resolve;
  });
  await window.webContents.executeJavaScript(
    "void prepareDeleteProviderProfile('pp_next'); true",
  );
  await waitFor(() => modelOverviewCalls === priorModelOverviewCalls + 1);
  account = { id: 9, email: 'third@example.com', displayName: 'Third Account' };
  window.webContents.send('identity:state', readyState());
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('[data-ready-account-name]')?.textContent === 'Third Account'"
      + " && document.querySelector('.account-center') === null",
  ));
  releaseOldModelOverview();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    phase: providerUi.phase,
    snapshot: providerUi.snapshot,
    pendingDelete: providerUi.pendingDelete,
    error: providerUi.error,
    message: providerUi.message,
  })`), {
    phase: 'idle',
    snapshot: null,
    pendingDelete: null,
    error: null,
    message: null,
  });

  smokeStep = 'ignore a stale Provider operation failure after an account switch';
  await window.webContents.executeJavaScript(`(() => {
    globalThis.__staleProviderOperation = new Promise((resolve, reject) => {
      globalThis.__rejectStaleProviderOperation = reject;
    });
    void runProviderOperation(
      () => globalThis.__staleProviderOperation,
      '旧账号操作已完成。',
    );
  })()`);
  await waitFor(() => window.webContents.executeJavaScript('providerUi.busy === true'));
  account = { id: 10, email: 'fourth@example.com', displayName: 'Fourth Account' };
  window.webContents.send('identity:state', readyState());
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('[data-ready-account-name]')?.textContent === 'Fourth Account'",
  ));
  await window.webContents.executeJavaScript(
    "globalThis.__rejectStaleProviderOperation(new Error('old account failure'))",
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    phase: providerUi.phase,
    snapshot: providerUi.snapshot,
    pendingDelete: providerUi.pendingDelete,
    error: providerUi.error,
    message: providerUi.message,
    busy: providerUi.busy,
  })`), {
    phase: 'idle',
    snapshot: null,
    pendingDelete: null,
    error: null,
    message: null,
    busy: false,
  });

  await window.webContents.executeJavaScript("document.getElementById('open-account-settings').click()");
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-settings-tab=\"account\"]').click()",
  );

  smokeStep = 'keep logout explicit inside account settings';
  await window.webContents.executeJavaScript("document.getElementById('settings-logout').click()");
  await waitFor(() => logoutCalls === 1);

  process.stdout.write('account center UI smoke passed\n');
  window.destroy();
  fs.rmSync(userData, { recursive: true, force: true });
  app.quit();
}

function registerFixtures() {
  ipcMain.handle('identity:get-state', () => readyState());
  ipcMain.handle('identity:logout', () => {
    logoutCalls += 1;
    return {};
  });
  ipcMain.handle('conversation:get-snapshot', () => ({ phase: 'idle' }));
  ipcMain.handle('agent:get-model-overview', async () => {
    modelOverviewCalls += 1;
    const selectedAccount = account;
    const pending = deferNextModelOverview;
    deferNextModelOverview = null;
    if (pending) await pending;
    const profile = providerSnapshotFor(selectedAccount).profiles[0];
    return {
      configuredProviderCount: 1,
      agents: [{
        agentId: 'job-agent',
        providerProfileId: profile.profileId,
        providerDisplayName: profile.displayName,
        modelId: 'test-model',
        bindingIssue: null,
        inheritedFromLegacyGlobal: false,
      }],
    };
  });
  ipcMain.handle('runtime:get-background-snapshot', () => ({
    host: { bridgeState: 'connected', mode: 'persistent_leader', socketName: 'fixture' },
    loginItem: { supported: true, openAtLogin: true, status: 'enabled' },
  }));
  ipcMain.handle('provider:get-snapshot', () => {
    providerSnapshotCalls += 1;
    const snapshot = providerSnapshotFor(account);
    const pending = deferNextProviderSnapshot;
    deferNextProviderSnapshot = null;
    return pending ? pending.then(() => snapshot) : snapshot;
  });
}

function providerSnapshotFor(selectedAccount) {
  const fixtures = {
    8: ['pp_next', 'Next Provider', 'NEXT'],
    9: ['pp_third', 'Third Provider', 'THRD'],
    10: ['pp_fourth', 'Fourth Provider', 'FRTH'],
  };
  const [profileId, displayName, credentialLastFour] = fixtures[selectedAccount.id]
    || ['pp_test', '测试供应商', 'TEST'];
  return {
    profiles: [{
      profileId,
      presetId: 'openai',
      displayName,
      protocol: 'openai_responses',
      baseUrl: 'https://api.example.test/v1',
      authKind: 'bearer_api_key',
      enabledModels: ['test-model'],
      credentialConfigured: true,
      credentialLastFour,
    }],
    probes: [],
    assignments: [],
    catalog: { catalogRevision: 1, providers: [] },
  };
}

function readyState() {
  return {
    phase: 'ready',
    account,
    subscription: { status: 'active', plan: 'monthly' },
    credits: { balance: 955 },
    access: { canEnterClient: true, reason: 'subscription_active' },
    agents: [{
      agentId: 'job-agent',
      displayName: 'Job Agent',
      description: 'Persistent career copilot',
      desiredState: 'running',
      runtimeState: 'resident',
    }],
    checkedAt: new Date().toISOString(),
    validationRevision: 1,
  };
}

async function accountCenterSnapshot(window) {
  const snapshot = await window.webContents.executeJavaScript(`({
    heading: document.querySelector('.account-center-header h1')?.innerText,
    labels: [...document.querySelectorAll('[data-settings-tab]')]
      .map((item) => item.querySelector('strong')?.innerText.trim()),
    active: [...document.querySelectorAll('[data-settings-tab].active')]
      .map((item) => item.dataset.settingsTab),
    currentCount: document.querySelectorAll(
      '[data-settings-tab][aria-current="page"]',
    ).length,
    accountEntryActive: document.getElementById('open-account-settings')
      ?.classList.contains('active'),
    accountName: document.querySelector('.account-center-identity strong')?.innerText,
    logout: document.getElementById('settings-logout')?.innerText.trim(),
  })`);
  return { ...snapshot, providerSnapshotCalls };
}

async function waitFor(predicate, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`account center UI smoke timed out at ${smokeStep}`);
}

function fail(error) {
  fs.rmSync(userData, { recursive: true, force: true });
  process.stderr.write(`account center UI smoke failed at ${smokeStep}: ${error.stack}\n`);
  app.exit(1);
}
