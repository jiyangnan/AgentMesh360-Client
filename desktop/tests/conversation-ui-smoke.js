'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const opens = [];
const prompts = [];
const permissionResponses = [];
const delayedConversationOpens = new Map();
let delayedConversationSend = null;
let conversationSendFailure = false;
const unsafeMarkdownText = [
  '在，我们可以从**上次进度**继续。',
  '',
  '- 第一项',
  '- 第二项',
  '',
  '`安全代码`',
  '<img src=x onerror="window.__unsafeMarkdownExecuted=true">',
].join('\n');
let currentConversation = { phase: 'idle' };
let managementBindingIssue = null;

app.whenReady().then(async () => {
  ipcMain.handle('identity:get-state', () => readyState());
  ipcMain.handle('conversation:get-snapshot', () => currentConversation);
  ipcMain.handle('agent:get-model-overview', () => ({
    agents: readyState().agents.map((agent) => ({
      agentId: agent.agentId,
      providerProfileId: 'pp_test',
      providerDisplayName: 'Test Provider',
      modelId: 'test-model',
      bindingIssue: null,
      inheritedFromLegacyGlobal: false,
    })),
  }));
  ipcMain.handle('runtime:get-background-snapshot', () => ({
    host: { bridgeState: 'connected', mode: 'persistent_leader' },
    loginItem: { supported: true, openAtLogin: true },
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
    bindingIssue: managementBindingIssue,
    inheritedFromLegacyGlobal: false,
    customization: {
      packageName: readyState().agents.find((agent) => agent.agentId === agentId)?.displayName,
      packageVersion: '1.0.0',
      packageDescription: 'Public package description',
      requestedPermissions: [],
      agentMd: { kind: 'agent_md', content: '', revision: 0, customized: false },
      userMd: { kind: 'user_md', content: '', revision: 0, customized: false },
    },
  }));
  ipcMain.handle('conversation:open', async (event, agentId) => {
    opens.push(agentId);
    assert.equal(readyState().agents.some((agent) => agent.agentId === agentId), true);
    const delayedOpen = delayedConversationOpens.get(agentId);
    if (delayedOpen) {
      delayedConversationOpens.delete(agentId);
      await delayedOpen.promise;
    }
    currentConversation = conversationState(agentId, [
      { id: 'message-1', role: 'user', text: `上次的 ${agentId} 工作还在吗？` },
      { id: 'message-2', role: 'assistant', text: unsafeMarkdownText },
    ]);
    event.sender.send('conversation:state', currentConversation);
    return currentConversation;
  });
  ipcMain.handle('conversation:send', async (event, text) => {
    prompts.push(text);
    const delayedSend = delayedConversationSend;
    delayedConversationSend = null;
    if (delayedSend) await delayedSend.promise;
    if (conversationSendFailure) {
      conversationSendFailure = false;
      throw new Error('fixture conversation send failed');
    }
    currentConversation = conversationState(currentConversation.agentId, [
      { id: 'message-1', role: 'user', text: '上次的岗位分析还在吗？' },
      { id: 'message-2', role: 'assistant', text: '在，我们可以从证据匹配继续。' },
      { id: 'message-3', role: 'user', text },
      { id: 'message-4', role: 'assistant', text: '已继续分析。' },
    ]);
    event.sender.send('conversation:state', currentConversation);
    return currentConversation;
  });
  ipcMain.handle('conversation:respond-permission', (event, interactionId, optionId) => {
    permissionResponses.push({ interactionId, optionId });
    currentConversation = { ...currentConversation };
    delete currentConversation.interaction;
    event.sender.send('conversation:state', currentConversation);
    return currentConversation;
  });
  ipcMain.handle('conversation:close', () => {
    currentConversation = { phase: 'idle' };
    return currentConversation;
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
  await window.loadFile(path.join(__dirname, '..', 'src', 'ui', 'index.html'));
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('[data-manage-agent=\"job-agent\"]') !== null",
  ));
  const agentActions = await window.webContents.executeJavaScript(`({
    jobAgent: document.querySelector('[data-manage-agent="job-agent"]') !== null,
    lectureAgent: document.querySelector('[data-manage-agent="lecturecast-agent"]') !== null,
    deployAgent: document.querySelector('[data-manage-agent="deploy-agent"]') !== null,
    dynamicAgent: document.querySelector('[data-manage-agent="future-agent"]') !== null,
    topLevelConversation: document.getElementById('nav-conversation') !== null,
    symbols: Array.from(document.querySelectorAll('.agent-symbol'), (node) => node.textContent),
  })`);
  assert.deepEqual(agentActions, {
    jobAgent: true,
    lectureAgent: true,
    deployAgent: true,
    dynamicAgent: true,
    topLevelConversation: false,
    symbols: ['J', 'L', 'D', 'F'],
  });
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-manage-agent=\"job-agent\"]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.getElementById('conversation-form') !== null",
  ));

  const openedDom = await window.webContents.executeJavaScript(`(() => {
    const workspace = document.querySelector('.workspace');
    const sidebar = document.querySelector('.sidebar');
    const rail = document.querySelector('.agent-workspace-rail');
    const main = document.querySelector('.agent-workspace-main');
    const gear = document.getElementById('agent-settings-button');
    const feed = document.querySelector('.conversation-feed');
    const transcript = document.querySelector('.conversation-transcript');
    const messageBody = document.querySelector('.conversation-message-body');
    const sender = document.querySelector('.conversation-message b');
    const composer = document.querySelector('#conversation-form textarea');
    const state = document.querySelector('.conversation-state');
    const gearRect = gear.getBoundingClientRect();
    const sidebarRect = sidebar.getBoundingClientRect();
    const railRect = rail.getBoundingClientRect();
    const mainRect = main.getBoundingClientRect();
    return {
      body: document.body.innerText,
      messages: document.querySelectorAll('.conversation-message').length,
      emptyGatesDisplay: getComputedStyle(document.querySelector('.conversation-gates')).display,
      hasThreeColumnWorkspace: workspace.classList.contains('agent-workspace-layout')
        && Boolean(sidebar && rail && main),
      hasPureConversation: Boolean(document.querySelector('.agent-conversation-workspace'))
        && Boolean(document.querySelector('.agent-chat-toolbar'))
        && Boolean(document.getElementById('conversation-form')),
      legacyPeerTabs: document.querySelectorAll('.agent-tabs, .agent-detail-header, .conversation-back').length,
      inlineSettings: document.querySelectorAll('[data-agent-setting]').length,
      toolbarTitles: Array.from(document.querySelectorAll('.agent-chat-identity h1'), (node) => node.textContent.trim()),
      residentAgentCount: document.querySelectorAll('[data-switch-resident-agent]').length,
      residentAgentNames: Array.from(
        document.querySelectorAll('[data-switch-resident-agent] strong'),
        (node) => node.textContent.trim(),
      ),
      activeResidentAgent: document.querySelector('[data-switch-resident-agent].active')?.dataset.switchResidentAgent,
      sessionCount: document.querySelectorAll('[data-agent-session]').length,
      activeSession: document.querySelector('[data-agent-session].active')?.dataset.agentSession,
      sessionTitle: document.querySelector('[data-agent-session="main"] strong')?.textContent.trim(),
      gearLabel: gear.getAttribute('aria-label'),
      gearWidth: gearRect.width,
      gearHeight: gearRect.height,
      messageFont: parseFloat(getComputedStyle(messageBody).fontSize),
      senderFont: parseFloat(getComputedStyle(sender).fontSize),
      composerFont: parseFloat(getComputedStyle(composer).fontSize),
      stateFont: parseFloat(getComputedStyle(state).fontSize),
      feedWidth: feed.getBoundingClientRect().width,
      transcriptWidth: transcript.getBoundingClientRect().width,
      noDocumentOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      noWorkspaceOverflow: workspace.scrollWidth <= workspace.clientWidth + 1,
      columnsOrdered: sidebarRect.right <= railRect.left + 1 && railRect.right <= mainRect.left + 1,
      strongText: document.querySelector('.conversation-message.assistant strong')?.textContent,
      listTexts: Array.from(
        document.querySelectorAll('.conversation-message.assistant li'),
        (node) => node.textContent,
      ),
      codeText: document.querySelector('.conversation-message.assistant code')?.textContent,
      unsafeElements: document.querySelectorAll('.conversation-message img, .conversation-message script').length,
      unsafeExecuted: window.__unsafeMarkdownExecuted === true,
    };
  })()`);
  assert.deepEqual(opens, ['job-agent']);
  assert.equal(openedDom.messages, 2);
  assert.equal(openedDom.emptyGatesDisplay, 'none');
  assert.equal(openedDom.body.includes('上次的 job-agent 工作还在吗？'), true);
  assert.equal(openedDom.body.includes('private-session-id'), false);
  assert.equal(openedDom.body.includes('/private/account-7'), false);
  assert.equal(openedDom.hasThreeColumnWorkspace, true);
  assert.equal(openedDom.hasPureConversation, true);
  assert.equal(openedDom.legacyPeerTabs, 0);
  assert.equal(openedDom.inlineSettings, 0);
  assert.deepEqual(openedDom.toolbarTitles, ['Job Agent']);
  assert.equal(openedDom.residentAgentCount, 2);
  assert.deepEqual(openedDom.residentAgentNames, ['Job Agent', 'Lecturecast Agent']);
  assert.equal(openedDom.activeResidentAgent, 'job-agent');
  assert.equal(openedDom.sessionCount, 1);
  assert.equal(openedDom.activeSession, 'main');
  assert.equal(openedDom.sessionTitle, '主会话');
  assert.equal(openedDom.gearLabel, '打开 Job Agent 设置');
  assert.equal(openedDom.gearWidth >= 44, true);
  assert.equal(openedDom.gearHeight >= 44, true);
  assert.equal(openedDom.messageFont >= 15, true);
  assert.equal(openedDom.senderFont >= 12, true);
  assert.equal(openedDom.composerFont >= 15, true);
  assert.equal(openedDom.stateFont >= 12, true);
  assert.equal(openedDom.feedWidth <= 881, true);
  assert.equal(openedDom.feedWidth <= openedDom.transcriptWidth, true);
  assert.equal(openedDom.noDocumentOverflow, true);
  assert.equal(openedDom.noWorkspaceOverflow, true);
  assert.equal(openedDom.columnsOrdered, true);
  assert.equal(openedDom.strongText, '上次进度');
  assert.deepEqual(openedDom.listTexts, ['第一项', '第二项']);
  assert.equal(openedDom.codeText, '安全代码');
  assert.equal(openedDom.unsafeElements, 0);
  assert.equal(openedDom.unsafeExecuted, false);

  const delayedLecturecastOpen = delayNextConversationOpen('lecturecast-agent');
  const raceOpenStart = opens.length;
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-switch-resident-agent=\"lecturecast-agent\"]').click()",
  );
  await waitFor(() => (
    opens.length === raceOpenStart + 1
    && opens.at(-1) === 'lecturecast-agent'
  ));
  assert.equal(await window.webContents.executeJavaScript(
    "document.querySelector('[data-switch-resident-agent=\"job-agent\"]')?.disabled",
  ), false);
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-switch-resident-agent=\"job-agent\"]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('.agent-chat-identity h1')?.textContent.trim() === 'Job Agent'",
  ));
  assert.deepEqual(opens.slice(raceOpenStart), ['lecturecast-agent']);
  delayedLecturecastOpen.release();
  await waitFor(() => (
    opens.length === raceOpenStart + 2
    && opens.at(-1) === 'job-agent'
  ));
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('#conversation-form[data-agent-id=\"job-agent\"]') !== null"
      + " && document.body.innerText.includes('上次的 job-agent 工作还在吗？')",
  ));
  const raceResult = await window.webContents.executeJavaScript(`({
    activeAgent: document.querySelector('[data-switch-resident-agent].active')?.dataset.switchResidentAgent,
    formAgent: document.querySelector('#conversation-form')?.dataset.agentId,
    hasJobHistory: document.body.innerText.includes('上次的 job-agent 工作还在吗？'),
    hasLecturecastHistory: document.body.innerText.includes('上次的 lecturecast-agent 工作还在吗？'),
    asksForRetry: document.querySelector('[data-reopen-conversation]') !== null,
  })`);
  assert.deepEqual(raceResult, {
    activeAgent: 'job-agent',
    formAgent: 'job-agent',
    hasJobHistory: true,
    hasLecturecastHistory: false,
    asksForRetry: false,
  });
  window.webContents.send('conversation:state', conversationState('lecturecast-agent', [
    { id: 'stale-lecturecast', role: 'assistant', text: '过期的 Lecturecast 推送不得覆盖 Job Agent。' },
  ]));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    activeAgent: document.querySelector('[data-switch-resident-agent].active')?.dataset.switchResidentAgent,
    formAgent: document.querySelector('#conversation-form')?.dataset.agentId,
    hasStalePush: document.body.innerText.includes('过期的 Lecturecast 推送不得覆盖 Job Agent。'),
    hasJobHistory: document.body.innerText.includes('上次的 job-agent 工作还在吗？'),
  })`), {
    activeAgent: 'job-agent',
    formAgent: 'job-agent',
    hasStalePush: false,
    hasJobHistory: true,
  });

  await window.webContents.executeJavaScript(`
    (() => {
      const input = document.querySelector('#conversation-form [name="message"]');
      input.value = '未发送的 Job Agent 草稿';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('agent-settings-button').click();
    })()
  `);
  await waitFor(() => window.webContents.executeJavaScript(
    "document.getElementById('agent-model-form') !== null",
  ));
  const settingsDom = await window.webContents.executeJavaScript(`({
    hasSettingsWorkspace: document.querySelector('.agent-settings-workspace') !== null,
    hasConversationForm: document.getElementById('conversation-form') !== null,
    hasRail: document.querySelector('.agent-workspace-rail') !== null,
    labels: Array.from(document.querySelectorAll('[data-agent-setting]'), (node) => node.textContent.trim()),
    activeSetting: document.querySelector('[data-agent-setting].active')?.dataset.agentSetting,
    sessionCount: document.querySelectorAll('[data-agent-session]').length,
  })`);
  assert.deepEqual(settingsDom, {
    hasSettingsWorkspace: true,
    hasConversationForm: false,
    hasRail: true,
    labels: ['模型', '行为', '用户偏好'],
    activeSetting: 'model',
    sessionCount: 1,
  });
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-agent-session=\"main\"]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('#conversation-form [name=\"message\"]')?.value === '未发送的 Job Agent 草稿'",
  ));
  assert.equal(await window.webContents.executeJavaScript(
    "document.documentElement.innerHTML.includes('未发送的 Job Agent 草稿')",
  ), false);

  await window.webContents.executeJavaScript(
    "document.querySelector('[data-switch-resident-agent=\"lecturecast-agent\"]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('#conversation-form[data-agent-id=\"lecturecast-agent\"]') !== null",
  ));
  assert.equal(await window.webContents.executeJavaScript(
    "document.querySelector('#conversation-form [name=\"message\"]')?.value",
  ), '');
  await window.webContents.executeJavaScript(`
    (() => {
      const input = document.querySelector('#conversation-form [name="message"]');
      input.value = '未发送的 Lecturecast Agent 草稿';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-switch-resident-agent="job-agent"]').click();
    })()
  `);
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('#conversation-form[data-agent-id=\"job-agent\"] [name=\"message\"]')?.value === '未发送的 Job Agent 草稿'",
  ));
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-switch-resident-agent=\"lecturecast-agent\"]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('#conversation-form[data-agent-id=\"lecturecast-agent\"] [name=\"message\"]')?.value === '未发送的 Lecturecast Agent 草稿'",
  ));
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-switch-resident-agent=\"job-agent\"]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('#conversation-form[data-agent-id=\"job-agent\"] [name=\"message\"]')?.value === '未发送的 Job Agent 草稿'",
  ));
  window.webContents.send('conversation:state', {
    ...currentConversation,
    planEntries: [
      { planId: 'plan-draft-refresh', content: '保持草稿', status: 'in_progress' },
    ],
  });
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('#conversation-form [name=\"message\"]')?.value === '未发送的 Job Agent 草稿'",
  ));
  await window.webContents.executeJavaScript(`
    (() => {
      const input = document.querySelector('#conversation-form [name="message"]');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);

  await window.webContents.executeJavaScript(
    "document.getElementById('nav-agents').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('[data-manage-agent=\"job-agent\"]') !== null",
  ));
  window.webContents.send('conversation:state', {
    ...conversationState('job-agent', [
      { id: 'message-1', role: 'assistant', text: '后台更新不应抢走当前页面。' },
    ]),
    streaming: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await window.webContents.executeJavaScript(
    "document.querySelector('[data-manage-agent=\"job-agent\"]') !== null",
  ), true);
  const opensBeforeBlockedAgentSwitch = opens.length;
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-manage-agent=\"lecturecast-agent\"]').click()",
  );
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(opens.length, opensBeforeBlockedAgentSwitch);
  assert.equal(await window.webContents.executeJavaScript(
    "document.querySelector('[data-manage-agent=\"lecturecast-agent\"]') !== null",
  ), true);
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-manage-agent=\"job-agent\"]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.getElementById('conversation-form') !== null",
  ));
  assert.equal(opens.length, opensBeforeBlockedAgentSwitch);

  window.webContents.send('conversation:state', {
    ...currentConversation,
    streaming: false,
  });
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('.conversation-state')?.innerText === '已连接'",
  ));

  const pendingSend = createBarrier();
  delayedConversationSend = pendingSend;
  await window.webContents.executeJavaScript(`
    (() => {
      const form = document.getElementById('conversation-form');
      form.elements.message.value = '继续匹配这份 JD';
      form.requestSubmit();
    })()
  `);
  await waitFor(() => prompts.length === 1);
  window.webContents.send('conversation:state', {
    ...currentConversation,
    streaming: false,
  });
  window.webContents.send('conversation:state', { phase: 'idle' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const opensBeforePendingSendSwitch = opens.length;
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    state: document.querySelector('.conversation-state')?.innerText,
    sendDisabled: document.querySelector('#conversation-form button[type="submit"]')?.disabled,
    lecturecastDisabled: document.querySelector('[data-switch-resident-agent="lecturecast-agent"]')?.disabled,
  })`), {
    state: 'Agent 正在处理',
    sendDisabled: true,
    lecturecastDisabled: true,
  });
  await window.webContents.executeJavaScript(
    "document.getElementById('nav-agents').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('[data-manage-agent=\"lecturecast-agent\"]')?.disabled === true",
  ));
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-manage-agent=\"lecturecast-agent\"]').click()",
  );
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(opens.length, opensBeforePendingSendSwitch);
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-manage-agent=\"job-agent\"]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.getElementById('conversation-form') !== null",
  ));
  assert.equal(opens.length, opensBeforePendingSendSwitch);
  pendingSend.resolve();
  await waitFor(() => window.webContents.executeJavaScript(
    "document.body.innerText.includes('已继续分析。')",
  ));
  assert.deepEqual(prompts, ['继续匹配这份 JD']);

  const pendingFailedSend = createBarrier();
  delayedConversationSend = pendingFailedSend;
  conversationSendFailure = true;
  await window.webContents.executeJavaScript(`
    (() => {
      const form = document.getElementById('conversation-form');
      form.elements.message.value = '发送失败后保留这段草稿';
      form.elements.message.dispatchEvent(new Event('input', { bubbles: true }));
      form.requestSubmit();
    })()
  `);
  await waitFor(() => prompts.length === 2);
  window.webContents.send('conversation:state', { phase: 'idle' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    state: document.querySelector('.conversation-state')?.innerText,
    sendDisabled: document.querySelector('#conversation-form button[type="submit"]')?.disabled,
    lecturecastDisabled: document.querySelector('[data-switch-resident-agent="lecturecast-agent"]')?.disabled,
  })`), {
    state: 'Agent 正在处理',
    sendDisabled: true,
    lecturecastDisabled: true,
  });
  pendingFailedSend.resolve();
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('#conversation-form [name=\"message\"]')?.value === '发送失败后保留这段草稿'",
  ));
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    error: document.querySelector('.conversation-error')?.innerText || '',
    lecturecastDisabled: document.querySelector('[data-switch-resident-agent="lecturecast-agent"]')?.disabled,
  })`), {
    error: '消息发送失败',
    lecturecastDisabled: false,
  });
  await window.webContents.executeJavaScript(`
    (() => {
      const input = document.querySelector('#conversation-form [name="message"]');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);

  currentConversation = {
    ...currentConversation,
    streaming: true,
    activities: [
      {
        activityId: 'activity-1',
        toolKind: 'read',
        status: 'completed',
        title: 'Read /private/account-7/resume.pdf',
        rawInput: { apiKey: 'sk-private' },
      },
      {
        activityId: 'activity-2',
        toolKind: 'execute',
        status: 'in_progress',
        title: 'rm -rf /private/account-7',
      },
    ],
    backgroundTasks: [
      {
        backgroundId: 'background-1',
        kind: 'command',
        status: 'running',
        command: 'curl -H "Authorization: Bearer sk-private" https://private.example',
        cwd: '/private/account-7',
      },
      {
        backgroundId: 'background-2',
        kind: 'monitor',
        status: 'stopped',
        output: 'private monitor output',
        signal: 'session_restart',
      },
      {
        backgroundId: 'private-background-id',
        kind: 'command',
        status: 'failed',
      },
    ],
    planEntries: [
      {
        planId: 'plan-1',
        content: '核对岗位要求',
        status: 'completed',
        todoId: 'private-todo-id',
        priority: 'high',
        meta: { token: 'sk-private' },
      },
      {
        planId: 'plan-2',
        content: '运行交叉测试',
        status: 'in_progress',
      },
      {
        planId: 'private-plan-id',
        content: 'Private invalid plan',
        status: 'pending',
      },
    ],
    planStatus: 'ready',
    artifacts: [
      {
        artifactId: 'role-fit-report',
        title: '岗位匹配报告',
        kind: 'document',
        sizeBytes: 183421,
        relativePath: 'artifacts/private-report.pdf',
        downloadUrl: 'file:///private/account-7/report.pdf',
        digest: 'private-digest',
      },
      {
        artifactId: 'lecture-audio',
        title: '课程音频',
        kind: 'audio',
        sizeBytes: 2383421,
      },
      {
        artifactId: 'control-title',
        title: 'Private\u0085Title',
        kind: 'document',
        sizeBytes: 10,
      },
    ],
    project: {
      title: '产品岗位第 3 轮',
      status: 'waiting_for_user',
      summary: '请确认下一批重点岗位。',
      privatePath: '/private/account-7/round.json',
      nextCommand: 'jobagent round status',
      steps: [
        {
          stepId: 'confirm-target',
          label: '确认目标岗位',
          status: 'completed',
          privateEvidence: 'private-digest',
        },
        {
          stepId: 'review-boss',
          label: '审核 Boss 机会',
          status: 'in_progress',
        },
      ],
    },
    projectStatus: 'ready',
    interaction: {
      interactionId: 'permission-1',
      kind: 'permission',
      title: 'Run the verified deploy command',
      toolKind: 'execute',
      options: [
        { optionId: 'option-1', label: '仅本次允许', decision: 'allow' },
        { optionId: 'option-2', label: '本次拒绝', decision: 'reject' },
      ],
    },
  };
  window.webContents.send('conversation:state', currentConversation);
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('[data-permission-option=\"option-1\"]') !== null",
  ));
  const permissionDom = await window.webContents.executeJavaScript(`({
    body: document.body.innerText,
    activityCount: document.querySelectorAll('[data-activity-id]').length,
    backgroundCount: document.querySelectorAll('[data-background-id]').length,
    planEntryCount: document.querySelectorAll('[data-plan-id]').length,
    artifactCount: document.querySelectorAll('[data-artifact-id]').length,
    projectCount: document.querySelectorAll('.conversation-project').length,
    projectStepCount: document.querySelectorAll('[data-project-step-id]').length,
    optionCount: document.querySelectorAll('[data-permission-option]').length,
    hasPermanentChoice: document.body.innerText.includes('永久允许'),
  })`);
  assert.equal(permissionDom.body.includes('Run the verified deploy command'), true);
  assert.equal(permissionDom.body.includes('读取资料'), true);
  assert.equal(permissionDom.body.includes('执行操作'), true);
  assert.equal(permissionDom.body.includes('已完成'), true);
  assert.equal(permissionDom.body.includes('执行中'), true);
  assert.equal(permissionDom.body.includes('后台命令'), true);
  assert.equal(permissionDom.body.includes('监控任务'), true);
  assert.equal(permissionDom.body.includes('运行中'), true);
  assert.equal(permissionDom.body.includes('已停止'), true);
  assert.equal(permissionDom.body.includes('本轮计划'), true);
  assert.equal(permissionDom.body.includes('模型工作计划，不等同于业务进度'), true);
  assert.equal(permissionDom.body.includes('核对岗位要求'), true);
  assert.equal(permissionDom.body.includes('运行交叉测试'), true);
  assert.equal(permissionDom.body.includes('岗位匹配报告'), true);
  assert.equal(permissionDom.body.includes('课程音频'), true);
  assert.equal(permissionDom.body.includes('文档'), true);
  assert.equal(permissionDom.body.includes('音频'), true);
  assert.equal(permissionDom.body.includes('产品岗位第 3 轮'), true);
  assert.equal(permissionDom.body.includes('请确认下一批重点岗位。'), true);
  assert.equal(permissionDom.body.includes('等待确认'), true);
  assert.equal(permissionDom.body.includes('确认目标岗位'), true);
  assert.equal(permissionDom.body.includes('审核 Boss 机会'), true);
  assert.equal(permissionDom.body.includes('/private/account-7'), false);
  assert.equal(permissionDom.body.includes('sk-private'), false);
  assert.equal(permissionDom.body.includes('rm -rf'), false);
  assert.equal(permissionDom.body.includes('private-digest'), false);
  assert.equal(permissionDom.body.includes('artifacts/private-report.pdf'), false);
  assert.equal(permissionDom.body.includes('jobagent round status'), false);
  assert.equal(permissionDom.body.includes('Private'), false);
  assert.equal(permissionDom.body.includes('private monitor output'), false);
  assert.equal(permissionDom.body.includes('session_restart'), false);
  assert.equal(permissionDom.body.includes('private.example'), false);
  assert.equal(permissionDom.body.includes('private-todo-id'), false);
  assert.equal(permissionDom.body.includes('Private invalid plan'), false);
  assert.equal(permissionDom.activityCount, 2);
  assert.equal(permissionDom.backgroundCount, 2);
  assert.equal(permissionDom.planEntryCount, 2);
  assert.equal(permissionDom.artifactCount, 2);
  assert.equal(permissionDom.projectCount, 1);
  assert.equal(permissionDom.projectStepCount, 2);
  assert.equal(permissionDom.optionCount, 2);
  assert.equal(permissionDom.hasPermanentChoice, false);
  await window.webContents.executeJavaScript(`
    (() => {
      const button = document.querySelector('[data-permission-option="option-1"]');
      button.click();
      button.click();
    })()
  `);
  await waitFor(() => permissionResponses.length === 1);
  assert.deepEqual(permissionResponses, [{
    interactionId: 'permission-1',
    optionId: 'option-1',
  }]);
  assert.equal(await window.webContents.executeJavaScript(
    "document.body.innerText.includes('权限请求已失效')",
  ), false);

  await window.reload();
  await waitFor(() => window.webContents.executeJavaScript(
    "document.body.innerText.includes('已继续分析。')",
  ));
  assert.equal(await window.webContents.executeJavaScript(
    "document.getElementById('conversation-form') !== null",
  ), true);

  currentConversation = {
    ...currentConversation,
    backgroundTasks: [{
      backgroundId: 'background-unsafe',
      kind: 'command',
      status: 'running',
      command: 'private unavailable command',
    }],
    backgroundStatus: 'unavailable',
  };
  window.webContents.send('conversation:state', currentConversation);
  await waitFor(() => window.webContents.executeJavaScript(
    "document.body.innerText.includes('后台活动状态暂时不可用。')",
  ));
  assert.equal(await window.webContents.executeJavaScript(
    "document.body.innerText.includes('private unavailable command')",
  ), false);

  currentConversation = {
    ...currentConversation,
    planEntries: [{
      planId: 'plan-unsafe',
      content: 'private unavailable plan',
      status: 'pending',
    }],
    planStatus: 'unavailable',
  };
  window.webContents.send('conversation:state', currentConversation);
  await waitFor(() => window.webContents.executeJavaScript(
    "document.body.innerText.includes('本轮计划暂时不可用。')",
  ));
  assert.equal(await window.webContents.executeJavaScript(
    "document.body.innerText.includes('private unavailable plan')",
  ), false);

  currentConversation = {
    ...currentConversation,
    phase: 'error',
    streaming: false,
    error: '后台连接已恢复，请重新打开对话以继续。',
  };
  window.webContents.send('conversation:state', currentConversation);
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('[data-reopen-conversation=\"job-agent\"]') !== null",
  ));
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-reopen-conversation=\"job-agent\"]').click()",
  );
  await waitFor(() => opens.length === opensBeforeBlockedAgentSwitch + 1);
  assert.equal(opens.at(-1), 'job-agent');

  currentConversation = conversationState('job-agent', [
    { id: 'restored-1', role: 'assistant', text: '这是重启后恢复的历史。' },
  ]);
  managementBindingIssue = {
    code: 'provider_unavailable',
    message: '原模型供应商已被删除或不可用，请重新选择。',
  };
  const restoreWindow = new BrowserWindow({
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
  await restoreWindow.loadFile(path.join(__dirname, '..', 'src', 'ui', 'index.html'));
  await waitFor(() => restoreWindow.webContents.executeJavaScript(
    "document.getElementById('conversation-fix-model') !== null",
  ));
  assert.deepEqual(await restoreWindow.webContents.executeJavaScript(`({
    restored: document.body.innerText.includes('这是重启后恢复的历史。'),
    textareaDisabled: document.querySelector('#conversation-form textarea')?.disabled,
    sendDisabled: document.querySelector('#conversation-form button[type="submit"]')?.disabled,
  })`), {
    restored: true,
    textareaDisabled: true,
    sendDisabled: true,
  });
  restoreWindow.destroy();
  await app.quit();
}).catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});

function readyState() {
  return {
    phase: 'ready',
    account: { id: 7, email: 'ferdinand@example.com', displayName: 'Ferdinand' },
    subscription: { status: 'active', plan: 'Pro', periodEnd: '2026-08-21 00:00:00' },
    credits: { balance: 1280 },
    access: { canEnterClient: true, reason: 'subscription_active' },
    agents: [
      {
        agentId: 'job-agent',
        displayName: 'Job Agent',
        description: '持续理解你的岗位目标、求职材料和当前进度。',
        desiredState: 'running',
        runtimeState: 'resident',
      },
      {
        agentId: 'lecturecast-agent',
        displayName: 'Lecturecast Agent',
        description: '把课程资料转化为可发布、可校验的音视频内容。',
        desiredState: 'running',
        runtimeState: 'resident',
      },
      {
        agentId: 'deploy-agent',
        displayName: 'Deploy Agent',
        description: '负责发布前检查、部署执行以及上线后的证据验证。',
        desiredState: 'stopped',
        runtimeState: 'available',
      },
      {
        agentId: 'future-agent',
        displayName: 'Future Agent',
        description: '通过动态 Agent Package 安装的未来 Agent。',
        desiredState: 'stopped',
        runtimeState: 'available',
      },
    ],
    checkedAt: new Date().toISOString(),
  };
}

function conversationState(agentId, messages) {
  const displayName = readyState().agents
    .find((agent) => agent.agentId === agentId)?.displayName || agentId;
  return {
    phase: 'ready',
    agentId,
    displayName,
    messages,
    activities: [],
    backgroundTasks: [],
    backgroundStatus: 'ready',
    planEntries: [],
    planStatus: 'ready',
    artifacts: [],
    project: null,
    projectStatus: 'ready',
    streaming: false,
    transcriptTruncated: false,
    error: null,
    stopReason: 'end_turn',
  };
}

function delayNextConversationOpen(agentId) {
  assert.equal(delayedConversationOpens.has(agentId), false);
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  const delayedOpen = { promise, release };
  delayedConversationOpens.set(agentId, delayedOpen);
  return delayedOpen;
}

function createBarrier() {
  let resolve;
  const promise = new Promise((release) => {
    resolve = release;
  });
  return { promise, resolve };
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('等待对话 UI 超时');
}
