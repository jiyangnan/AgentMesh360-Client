'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

let mode = 'no_provider';
let overviewError = false;
const initialOverviewBarrier = createBarrier();
let overviewBarrier = initialOverviewBarrier;
let overviewCalls = 0;
let catalogRefreshCalls = 0;
let providerSnapshotCalls = 0;
let smokeStep = 'startup';

app.whenReady().then(async () => {
  ipcMain.handle('identity:get-state', () => readyState(mode));
  ipcMain.handle('agent:get-model-overview', async () => {
    overviewCalls += 1;
    const requestedMode = mode;
    const pendingBarrier = overviewBarrier;
    overviewBarrier = null;
    if (pendingBarrier) await pendingBarrier.promise;
    if (overviewError) throw new Error('fixture overview unavailable');
    return modelOverview(requestedMode);
  });
  ipcMain.handle('agent:refresh-model-overview', (event) => {
    catalogRefreshCalls += 1;
    if (mode === 'no_agents') mode = 'provider_ready';
    event.sender.send('identity:state', readyState(mode));
    return modelOverview(mode);
  });
  ipcMain.handle('provider:get-snapshot', () => {
    providerSnapshotCalls += 1;
    return {
      profiles: [],
      assignments: [],
      probes: [],
      catalog: { catalogRevision: 1, providers: [] },
    };
  });
  ipcMain.handle('agent:get-management-snapshot', (_event, agentId) => ({
    agentId,
    profiles: [{
      profileId: 'pp_test',
      displayName: '测试供应商',
      enabledModels: ['test-model'],
      credentialConfigured: true,
    }],
    modelBinding: {
      scopeKind: 'agent',
      scopeId: agentId,
      role: 'main',
      providerProfileId: 'pp_test',
      modelId: 'test-model',
    },
    bindingIssue: {
      code: 'model_unavailable',
      message: '原模型已不可用，请重新选择。',
    },
    inheritedFromLegacyGlobal: false,
    customization: {
      packageName: displayName(agentId),
      packageVersion: '1.0.0',
      packageDescription: 'Fixture Agent',
      requestedPermissions: [],
      agentMd: { kind: 'agent_md', content: '', revision: 0, customized: false },
      userMd: { kind: 'user_md', content: '', revision: 0, customized: false },
    },
  }));
  ipcMain.handle('conversation:get-snapshot', () => ({ phase: 'idle' }));
  ipcMain.handle('runtime:get-background-snapshot', () => ({
    host: { bridgeState: 'connected', mode: 'persistent_leader' },
    loginItem: { supported: true, openAtLogin: true },
  }));
  for (const channel of [
    'identity:login',
    'identity:logout',
    'identity:recheck',
    'external:open-subscription',
    'external:open-registration',
  ]) ipcMain.handle(channel, () => ({}));

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

  smokeStep = 'load initial guide';
  await window.loadFile(path.join(__dirname, '..', 'src', 'ui', 'index.html'));
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('.onboarding-strip.loading') !== null",
  ));
  assert.deepEqual(await guideSnapshot(window), {
    phase: 'loading',
    ariaBusy: 'true',
    statuses: ['待确认', '待确认', '待确认'],
    currentCount: 0,
    actionIds: [],
    stepCount: 3,
    ariaLive: 'polite',
  });
  assert.equal(await window.webContents.executeJavaScript(
    "document.querySelectorAll('.agent-card').length",
  ), 3);

  smokeStep = 'settle no-Provider state';
  initialOverviewBarrier.resolve();
  await waitForGuidePhase(window, 'ready');
  assert.deepEqual(await guideSnapshot(window), {
    phase: 'ready',
    ariaBusy: null,
    statuses: ['当前步骤', '待完成', '待完成'],
    currentCount: 1,
    actionIds: ['onboarding-go-providers'],
    stepCount: 3,
    ariaLive: 'polite',
  });
  assert.equal(providerSnapshotCalls, 0);
  await assertGuideLayout(window);

  smokeStep = 'open Provider list by keyboard only after explicit action';
  assert.equal(await window.webContents.executeJavaScript(`(() => {
    const action = document.getElementById('onboarding-go-providers');
    action.focus();
    return document.activeElement === action
      && action.tagName === 'BUTTON'
      && action.tabIndex === 0
      && action.disabled === false;
  })()`), true);
  assert.equal(await window.webContents.executeJavaScript(`(() => {
    const rules = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]);
    return rules.some((rule) => rule.selectorText?.includes('button:focus-visible')
      && parseFloat(rule.style.outlineWidth) >= 2);
  })()`), true);
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('.provider-list-shell') !== null",
  ));
  assert.equal(providerSnapshotCalls, 1);

  smokeStep = 'repair Provider before using an existing resident Agent';
  await showMode(window, 'resident_without_provider');
  assert.deepEqual(await guideSnapshot(window), {
    phase: 'ready',
    ariaBusy: null,
    statuses: ['当前步骤', '已完成', '待完成'],
    currentCount: 1,
    actionIds: ['onboarding-go-providers'],
    stepCount: 3,
    ariaLive: 'polite',
  });

  smokeStep = 'show activatable Agent state';
  await showMode(window, 'provider_ready');
  assert.deepEqual(await guideSnapshot(window), {
    phase: 'ready',
    ariaBusy: null,
    statuses: ['已完成', '当前步骤', '待完成'],
    currentCount: 1,
    actionIds: ['onboarding-go-agents'],
    stepCount: 3,
    ariaLive: 'polite',
  });
  await window.webContents.executeJavaScript(
    "document.getElementById('onboarding-go-agents').click()",
  );
  assert.equal(await window.webContents.executeJavaScript(
    "document.activeElement?.dataset.manageAgent",
  ), 'job-agent');

  smokeStep = 'avoid empty Agent action';
  await showMode(window, 'no_agents');
  const callsBeforeRetry = overviewCalls;
  assert.equal(await window.webContents.executeJavaScript(
    "document.getElementById('onboarding-go-agents') === null",
  ), true);
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    action: document.querySelector('.onboarding-step-action')?.id,
    heading: document.querySelector('.onboarding-heading h2')?.innerText,
  })`), {
    action: 'onboarding-refresh-agents',
    heading: '暂时没有可激活的 Agent',
  });
  await window.webContents.executeJavaScript(
    "document.getElementById('onboarding-refresh-agents').click()",
  );
  await waitFor(() => catalogRefreshCalls === 1);
  await waitFor(() => overviewCalls >= callsBeforeRetry);
  await waitForGuidePhase(window, 'ready');
  assert.equal(await window.webContents.executeJavaScript(
    "document.querySelectorAll('.agent-card').length",
  ), 3);

  smokeStep = 'recover an overview error without guessing state';
  overviewError = true;
  await showMode(window, 'provider_ready', { expectedPhase: 'error' });
  assert.deepEqual(await guideSnapshot(window), {
    phase: 'error',
    ariaBusy: null,
    statuses: ['待确认', '待确认', '待确认'],
    currentCount: 0,
    actionIds: ['onboarding-retry'],
    stepCount: 3,
    ariaLive: 'polite',
  });
  overviewError = false;
  await window.webContents.executeJavaScript(
    "document.getElementById('onboarding-retry').click()",
  );
  await waitForGuidePhase(window, 'ready');

  smokeStep = 'ignore a stale overview after account switch';
  const staleOverviewBarrier = createBarrier();
  mode = 'healthy';
  overviewBarrier = staleOverviewBarrier;
  const callsBeforeStaleOverview = overviewCalls;
  await window.webContents.executeJavaScript(`
    workspaceView = 'agents';
    agentOverviewUi = { phase: 'idle', snapshot: null, error: null };
    renderReady(currentState);
  `);
  await waitFor(() => overviewCalls > callsBeforeStaleOverview);
  mode = 'no_provider';
  window.webContents.send('identity:state', {
    ...readyState('no_provider'),
    account: { id: 8, email: 'next@example.com', displayName: 'Next User' },
  });
  await waitFor(() => window.webContents.executeJavaScript(
    "readyAccountId === 8 && agentOverviewUi.phase === 'ready'",
  ));
  staleOverviewBarrier.resolve();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    accountId: readyAccountId,
    providerCount: agentOverviewUi.snapshot?.configuredProviderCount,
    statuses: [...document.querySelectorAll('.onboarding-step-status')]
      .map((item) => item.innerText.trim()),
  })`), {
    accountId: 8,
    providerCount: 0,
    statuses: ['当前步骤', '待完成', '待完成'],
  });

  smokeStep = 'route an invalid resident to its model settings';
  await showMode(window, 'invalid_resident');
  assert.equal(await window.webContents.executeJavaScript(
    "document.getElementById('onboarding-fix-agent')?.innerText",
  ), '设置 Job Agent 模型');
  assert.equal(await window.webContents.executeJavaScript(
    "document.querySelector('.agent-model-alert')?.innerText.includes('Job Agent')",
  ), true);
  await window.webContents.executeJavaScript(
    "document.getElementById('onboarding-fix-agent').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.getElementById('agent-model-form') !== null",
  ));
  assert.equal(await window.webContents.executeJavaScript(
    "document.querySelector('[data-agent-setting=\"model\"]')?.classList.contains('active')",
  ), true);

  smokeStep = 'keep a starting Agent on activation step';
  await showMode(window, 'starting');
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    heading: document.querySelector('.onboarding-heading h2')?.innerText,
    statuses: [...document.querySelectorAll('.onboarding-step-status')]
      .map((item) => item.innerText.trim()),
    action: document.getElementById('onboarding-focus-agent')?.innerText.trim(),
  })`), {
    heading: 'Job Agent 正在启动',
    statuses: ['已完成', '当前步骤', '待完成'],
    action: '查看 Job Agent 状态',
  });
  assert.equal(await window.webContents.executeJavaScript(
    "document.getElementById('onboarding-open-agent') === null",
  ), true);

  smokeStep = 'treat activatingAgentId as an in-progress activation';
  await showMode(window, 'activating_pending');
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    heading: document.querySelector('.onboarding-heading h2')?.innerText,
    action: document.getElementById('onboarding-focus-agent')?.innerText.trim(),
    disabledCardAction: document.querySelector('[data-manage-agent="job-agent"]')?.disabled,
  })`), {
    heading: 'Job Agent 正在启动',
    action: '查看 Job Agent 状态',
    disabledCardAction: true,
  });
  await window.webContents.executeJavaScript(
    "document.getElementById('onboarding-focus-agent').click()",
  );
  assert.equal(await window.webContents.executeJavaScript(
    "document.activeElement?.dataset.agentCard",
  ), 'job-agent');

  smokeStep = 'keep returning home compact and reuse guide in Settings';
  await showMode(window, 'mixed', { expectedPhase: null });
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('.onboarding-strip') === null",
  ));
  assert.equal(await window.webContents.executeJavaScript(
    "document.querySelector('.agent-model-alert')?.innerText.includes('Deploy Agent')",
  ), true);
  await window.webContents.executeJavaScript(
    "document.getElementById('nav-settings').click(); document.querySelector('[data-settings-tab=\"guide\"]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('.onboarding-strip.settings-guide.ready') !== null",
  ));
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    statuses: [...document.querySelectorAll('.onboarding-step-status')]
      .map((item) => item.innerText.trim()),
    currentCount: document.querySelectorAll('[aria-current="step"]').length,
    action: document.getElementById('onboarding-open-agent')?.innerText.trim(),
  })`), {
    statuses: ['已完成', '已完成', '当前步骤'],
    currentCount: 1,
    action: '打开或继续 Job Agent',
  });

  smokeStep = 'verify narrow layout';
  window.setSize(720, 760);
  await showMode(window, 'provider_ready');
  await assertGuideLayout(window);

  process.stdout.write('first-use guide UI smoke passed\n');
  window.destroy();
  app.quit();
}).catch((error) => {
  process.stderr.write(`first-use guide UI smoke failed at ${smokeStep}: ${error.stack}\n`);
  app.exit(1);
});

async function showMode(window, nextMode, { expectedPhase = 'ready' } = {}) {
  mode = nextMode;
  const nextState = readyState(mode);
  await window.webContents.executeJavaScript(`
    currentState = {
      ...currentState,
      agents: ${JSON.stringify(nextState.agents)},
      activatingAgentId: ${JSON.stringify(nextState.activatingAgentId)},
    };
    workspaceView = 'agents';
    agentOverviewUi = { phase: 'idle', snapshot: null, error: null };
    renderReady(currentState);
  `);
  if (expectedPhase) {
    await waitForGuidePhase(window, expectedPhase);
  } else {
    await waitFor(() => window.webContents.executeJavaScript(
      "agentOverviewUi.phase === 'ready'",
    ));
  }
}

async function waitForGuidePhase(window, expected) {
  await waitFor(() => window.webContents.executeJavaScript(
    `document.querySelector('.onboarding-strip[data-onboarding-phase="${expected}"]') !== null`,
  ));
}

async function guideSnapshot(window) {
  return window.webContents.executeJavaScript(`({
    phase: document.querySelector('.onboarding-strip')?.dataset.onboardingPhase,
    ariaBusy: document.querySelector('.onboarding-strip')?.getAttribute('aria-busy'),
    statuses: [...document.querySelectorAll('.onboarding-step-status')]
      .map((item) => item.innerText.trim()),
    currentCount: document.querySelectorAll('[aria-current="step"]').length,
    actionIds: [...document.querySelectorAll('.onboarding-strip button')]
      .map((item) => item.id),
    stepCount: document.querySelectorAll('.onboarding-step').length,
    ariaLive: document.querySelector('.onboarding-strip')?.getAttribute('aria-live'),
  })`);
}

async function assertGuideLayout(window) {
  const metrics = await window.webContents.executeJavaScript(`(() => {
    const strip = document.querySelector('.onboarding-strip');
    const action = strip?.querySelector('button');
    const stripRect = strip?.getBoundingClientRect();
    const actionStyle = action ? getComputedStyle(action) : null;
    return {
      noDocumentOverflow: document.documentElement.scrollWidth
        <= document.documentElement.clientWidth + 1,
      stripFitsHorizontally: Boolean(stripRect)
        && stripRect.left >= 0
        && stripRect.right <= window.innerWidth + 1,
      actionHeight: action ? action.getBoundingClientRect().height : 0,
      actionFontSize: actionStyle ? parseFloat(actionStyle.fontSize) : 0,
      statusFontSizes: [...strip.querySelectorAll('.onboarding-step-status')]
        .map((item) => parseFloat(getComputedStyle(item).fontSize)),
      descriptionFontSizes: [...strip.querySelectorAll('.onboarding-step-copy p')]
        .map((item) => parseFloat(getComputedStyle(item).fontSize)),
      stepOpacities: [...strip.querySelectorAll('.onboarding-step')]
        .map((item) => parseFloat(getComputedStyle(item).opacity)),
    };
  })()`);
  assert.equal(metrics.noDocumentOverflow, true);
  assert.equal(metrics.stripFitsHorizontally, true);
  assert.equal(metrics.actionHeight >= 44, true);
  assert.equal(metrics.actionFontSize >= 13, true);
  assert.equal(metrics.statusFontSizes.every((size) => size >= 12), true);
  assert.equal(metrics.descriptionFontSizes.every((size) => size >= 12), true);
  assert.equal(metrics.stepOpacities.every((opacity) => opacity === 1), true);
}

function readyState(selectedMode) {
  return {
    phase: 'ready',
    account: { id: 7, email: 'guide@example.com', displayName: 'Guide User' },
    subscription: { status: 'active', plan: 'Pro', periodEnd: '2026-08-21 00:00:00' },
    credits: { balance: 100 },
    access: { canEnterClient: true, reason: 'subscription_active' },
    validationRevision: 1,
    activatingAgentId: selectedMode === 'activating_pending' ? 'job-agent' : null,
    agents: agentFixtures(selectedMode),
    checkedAt: new Date().toISOString(),
  };
}

function agentFixtures(selectedMode) {
  if (selectedMode === 'no_agents') return [];
  const running = new Set(
    selectedMode === 'mixed'
      ? ['job-agent', 'deploy-agent']
      : ['resident_without_provider', 'invalid_resident', 'healthy', 'starting'].includes(selectedMode)
        ? ['job-agent']
        : [],
  );
  return ['job-agent', 'lecturecast-agent', 'deploy-agent'].map((agentId) => ({
    agentId,
    displayName: displayName(agentId),
    description: `${displayName(agentId)} fixture`,
    version: '1.0.0',
    desiredState: running.has(agentId) ? 'running' : 'stopped',
    runtimeState: running.has(agentId)
      ? selectedMode === 'starting' && agentId === 'job-agent' ? 'starting' : 'resident'
      : 'available',
  }));
}

function modelOverview(selectedMode) {
  const configuredProviderCount = ['no_provider', 'resident_without_provider']
    .includes(selectedMode) ? 0 : 1;
  return {
    configuredProviderCount,
    agents: agentFixtures(selectedMode).map((agent) => {
      const valid = agent.agentId === 'job-agent'
        && ['healthy', 'mixed', 'starting'].includes(selectedMode);
      const invalid = (
        (agent.agentId === 'job-agent' && selectedMode === 'invalid_resident')
        || (agent.agentId === 'deploy-agent' && selectedMode === 'mixed')
      );
      return {
        agentId: agent.agentId,
        providerProfileId: valid || invalid ? 'pp_test' : null,
        providerDisplayName: valid || invalid ? '测试供应商' : null,
        modelId: valid || invalid ? 'test-model' : null,
        bindingIssue: valid
          ? null
          : invalid
            ? { code: 'model_unavailable', message: '原模型已不可用，请重新选择。' }
            : { code: 'model_not_configured', message: '这个 Agent 尚未选择模型。' },
        inheritedFromLegacyGlobal: false,
      };
    }),
  };
}

function displayName(agentId) {
  if (agentId === 'job-agent') return 'Job Agent';
  if (agentId === 'lecturecast-agent') return 'LectureCast Agent';
  return 'Deploy Agent';
}

function createBarrier() {
  let resolve;
  const promise = new Promise((release) => { resolve = release; });
  return { promise, resolve };
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('等待首次使用引导 UI 超时');
}
