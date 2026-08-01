'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const windowWidth = visualDimension(process.env.AGENTMESH360_VISUAL_WIDTH, 1280);
const windowHeight = visualDimension(process.env.AGENTMESH360_VISUAL_HEIGHT, 800);
const screenshotPath = process.env.AGENTMESH360_SCREENSHOT || '';
let conversationSnapshot = { phase: 'idle' };

const longAssistantMessage = [
  '你好！我是 **Job Agent**，你的持久化职业助手，运行在 AgentMesh360 平台上。',
  '',
  '我可以帮你做这些事情：',
  '',
  '- 建立职业档案 — 记录你的背景、技能、求职方向和偏好',
  '- 职位搜索与匹配 — 根据你的目标角色和约束条件寻找合适的机会',
  '- 简历与求职信优化 — 针对具体职位打磨申请材料',
  '- 申请管理 — 追踪已投递的职位、面试进展和后续步骤',
  '- 任务委派 — 将调研、信息收集等任务分派给代理执行',
  '',
  '我的对话是**持久化的**，会跨会话保持连续性，不会把每次对话当成全新的开始。',
  '',
  '---',
  '',
  '有什么我可以帮你的吗？比如：',
  '',
  '- 你正在找工作，还是想了解某个行业方向？',
  '- 想让我先帮你梳理一下职业背景和目标？',
  '- 或者有具体的求职问题需要解决？',
  '',
  '你也可以直接继续下面任意一项：',
  '',
  '- 把目标岗位发给我，继续做岗位匹配',
  '- 把简历草稿发给我，继续打磨申请材料',
  '- 告诉我最新面试进度，继续维护申请记录',
  '- 临时离开后再回来，仍从当前进度继续',
  '',
  '随时告诉我。',
].join('\n');

app.whenReady().then(async () => {
  ipcMain.handle('identity:get-state', () => readyState());
  ipcMain.handle('conversation:get-snapshot', () => conversationSnapshot);
  ipcMain.handle('conversation:open', (event, agentId) => {
    conversationSnapshot = {
      phase: 'ready',
      agentId,
      displayName: 'Job Agent',
      messages: [
        { id: 'compact-user', role: 'user', text: '你好，你是谁' },
        { id: 'compact-assistant', role: 'assistant', text: longAssistantMessage },
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
    event.sender.send('conversation:state', conversationSnapshot);
    return conversationSnapshot;
  });
  ipcMain.handle('agent:get-model-overview', () => ({
    agents: [{
      agentId: 'job-agent',
      providerProfileId: 'pp_test',
      providerDisplayName: 'Test Provider',
      modelId: 'test-model',
      bindingIssue: null,
      inheritedFromLegacyGlobal: false,
    }],
  }));
  ipcMain.handle('agent:get-management-snapshot', (_event, agentId) => ({
    agentId,
    profiles: [{
      profileId: 'pp_test',
      displayName: 'Test Provider',
      enabledModels: ['test-model'],
    }],
    modelBinding: {
      scopeKind: 'agent',
      scopeId: agentId,
      role: 'main',
      providerProfileId: 'pp_test',
      modelId: 'test-model',
    },
    bindingIssue: null,
    inheritedFromLegacyGlobal: false,
    customization: {
      packageName: 'Job Agent',
      packageVersion: '1.0.0',
      packageDescription: 'Persistent career copilot.',
      requestedPermissions: [],
      agentMd: { kind: 'agent_md', content: '', revision: 0, customized: false },
      userMd: { kind: 'user_md', content: '', revision: 0, customized: false },
    },
  }));
  ipcMain.handle('provider:get-snapshot', () => ({
    profiles: [{
      profileId: 'pp_test',
      displayName: 'Test Provider',
      enabledModels: ['test-model'],
    }],
    catalog: { providers: [], catalogRevision: 1 },
    probes: [],
  }));
  ipcMain.handle('runtime:get-background-snapshot', () => ({
    host: { bridgeState: 'connected', mode: 'persistent_leader' },
    loginItem: { supported: true, openAtLogin: true },
  }));
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
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('[data-manage-agent=\"job-agent\"]') !== null",
  ));
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-manage-agent=\"job-agent\"]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelectorAll('.conversation-message').length === 2"
      + " && document.querySelector('.conversation-state')?.textContent.trim() === '已连接'",
  ));
  await new Promise((resolve) => setTimeout(resolve, 180));

  const metrics = await window.webContents.executeJavaScript(`(() => {
    const workspace = document.querySelector('.workspace.agent-workspace-layout');
    const main = document.querySelector('.workspace-main.agent-workspace-main');
    const shell = document.querySelector('.agent-conversation-workspace .conversation-shell');
    const transcript = document.querySelector('.conversation-transcript');
    const dock = document.querySelector('.conversation-composer-dock');
    const form = document.getElementById('conversation-form');
    const textarea = form?.elements.message;
    const messageBody = document.querySelector('.conversation-message.assistant .conversation-message-body');
    const rect = (node) => {
      const value = node.getBoundingClientRect();
      return { top: value.top, bottom: value.bottom, height: value.height };
    };
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      documentClientHeight: document.documentElement.clientHeight,
      documentScrollHeight: document.documentElement.scrollHeight,
      mainClientHeight: main.clientHeight,
      mainScrollHeight: main.scrollHeight,
      workspace: rect(workspace),
      main: rect(main),
      shell: rect(shell),
      transcript: rect(transcript),
      dock: rect(dock),
      form: rect(form),
      textarea: rect(textarea),
      transcriptClientHeight: transcript.clientHeight,
      transcriptScrollHeight: transcript.scrollHeight,
      transcriptOverflowY: getComputedStyle(transcript).overflowY,
      messageFont: parseFloat(getComputedStyle(messageBody).fontSize),
      composerFont: parseFloat(getComputedStyle(textarea).fontSize),
    };
  })()`);

  if (screenshotPath) {
    const image = await window.webContents.capturePage();
    fs.writeFileSync(screenshotPath, image.toPNG());
  }

  process.stdout.write(`${JSON.stringify(metrics)}\n`);
  assert.equal(metrics.innerWidth >= 1280, true);
  assert.equal(metrics.innerHeight >= 760, true);
  assert.equal(metrics.documentScrollHeight <= metrics.documentClientHeight + 1, true);
  assert.equal(metrics.mainScrollHeight <= metrics.mainClientHeight + 1, true);
  assert.equal(metrics.workspace.bottom <= metrics.innerHeight + 1, true);
  assert.equal(metrics.main.bottom <= metrics.innerHeight + 1, true);
  assert.equal(metrics.shell.bottom <= metrics.main.bottom + 1, true);
  assert.equal(metrics.transcript.bottom <= metrics.dock.top + 1, true);
  assert.equal(metrics.dock.bottom <= metrics.innerHeight + 1, true);
  assert.equal(metrics.form.bottom <= metrics.dock.bottom + 1, true);
  assert.equal(metrics.textarea.bottom <= metrics.form.bottom + 1, true);
  assert.equal(metrics.transcriptScrollHeight > metrics.transcriptClientHeight, true);
  assert.equal(['auto', 'scroll'].includes(metrics.transcriptOverflowY), true);
  assert.equal(metrics.messageFont >= 14 && metrics.messageFont < 15, true);
  assert.equal(metrics.composerFont >= 15, true);

  conversationSnapshot = {
    ...conversationSnapshot,
    interaction: {
      interactionId: 'compact-permission',
      kind: 'permission',
      title: '执行已验证的本机操作',
      toolKind: 'execute',
      options: [
        { optionId: 'allow-once', label: '仅本次允许', decision: 'allow' },
        { optionId: 'reject-once', label: '本次拒绝', decision: 'reject' },
      ],
    },
  };
  window.webContents.send('conversation:state', conversationSnapshot);
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('[data-permission-option=\"allow-once\"]') !== null",
  ));
  const gatedMetrics = await window.webContents.executeJavaScript(`(() => {
    const transcriptRect = document.querySelector('.conversation-transcript').getBoundingClientRect();
    const dockRect = document.querySelector('.conversation-composer-dock').getBoundingClientRect();
    const formRect = document.getElementById('conversation-form').getBoundingClientRect();
    return {
      permissionVisible: document.querySelector('.conversation-permission') !== null,
      transcriptHeight: transcriptRect.height,
      transcriptBottom: transcriptRect.bottom,
      dockTop: dockRect.top,
      dockBottom: dockRect.bottom,
      formBottom: formRect.bottom,
      innerHeight: window.innerHeight,
    };
  })()`);
  assert.equal(gatedMetrics.permissionVisible, true);
  assert.equal(gatedMetrics.transcriptHeight > 200, true);
  assert.equal(gatedMetrics.transcriptBottom <= gatedMetrics.dockTop + 1, true);
  assert.equal(gatedMetrics.dockBottom <= gatedMetrics.innerHeight + 1, true);
  assert.equal(gatedMetrics.formBottom <= gatedMetrics.innerHeight + 1, true);

  await app.quit();
}).catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});

function readyState() {
  return {
    phase: 'ready',
    account: { id: 7, email: 'compact@example.com', displayName: 'Compact Tester' },
    subscription: { status: 'active', plan: 'Pro', periodEnd: '2026-08-21 00:00:00' },
    credits: { balance: 1280 },
    access: { canEnterClient: true, reason: 'subscription_active' },
    agents: [{
      agentId: 'job-agent',
      displayName: 'Job Agent',
      description: 'Persistent career copilot.',
      desiredState: 'running',
      runtimeState: 'resident',
    }],
    checkedAt: new Date().toISOString(),
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
  throw new Error('等待 13 寸对话布局超时');
}
