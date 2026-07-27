'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const opens = [];
const prompts = [];
const permissionResponses = [];
let currentConversation = { phase: 'idle' };

app.whenReady().then(async () => {
  ipcMain.handle('identity:get-state', () => readyState());
  ipcMain.handle('conversation:get-snapshot', () => currentConversation);
  ipcMain.handle('conversation:open', (event, agentId) => {
    opens.push(agentId);
    assert.equal(readyState().agents.some((agent) => agent.agentId === agentId), true);
    currentConversation = conversationState(agentId, [
      { id: 'message-1', role: 'user', text: `上次的 ${agentId} 工作还在吗？` },
      { id: 'message-2', role: 'assistant', text: '在，我们可以从上次进度继续。' },
    ]);
    event.sender.send('conversation:state', currentConversation);
    return currentConversation;
  });
  ipcMain.handle('conversation:send', (event, text) => {
    prompts.push(text);
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
    "document.querySelector('[data-open-conversation=\"job-agent\"]') !== null",
  ));
  const agentActions = await window.webContents.executeJavaScript(`({
    jobConversation: document.querySelector('[data-open-conversation="job-agent"]') !== null,
    lectureConversation: document.querySelector('[data-open-conversation="lecturecast-agent"]') !== null,
    deployConversation: document.querySelector('[data-open-conversation="deploy-agent"]') !== null,
    dynamicConversation: document.querySelector('[data-open-conversation="future-agent"]') !== null,
    activationOnly: document.querySelectorAll('[data-activate-agent]').length,
    symbols: Array.from(document.querySelectorAll('.agent-symbol'), (node) => node.textContent),
  })`);
  assert.deepEqual(agentActions, {
    jobConversation: true,
    lectureConversation: true,
    deployConversation: true,
    dynamicConversation: true,
    activationOnly: 0,
    symbols: ['J', 'L', 'D', 'F'],
  });
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-open-conversation=\"future-agent\"]').click()",
  );
  await waitFor(() => opens.length === 1);
  await waitFor(() => window.webContents.executeJavaScript(
    "document.body.innerText.includes('Future Agent')",
  ));
  await window.webContents.executeJavaScript(
    "document.querySelector('.conversation-back').click()",
  );
  await window.webContents.executeJavaScript(
    "document.querySelector('[data-open-conversation=\"job-agent\"]').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.getElementById('conversation-form') !== null",
  ));

  const openedDom = await window.webContents.executeJavaScript(`({
    body: document.body.innerText,
    messages: document.querySelectorAll('.conversation-message').length,
    emptyGatesDisplay: getComputedStyle(document.querySelector('.conversation-gates')).display,
  })`);
  assert.deepEqual(opens, ['future-agent', 'job-agent']);
  assert.equal(openedDom.messages, 2);
  assert.equal(openedDom.emptyGatesDisplay, 'none');
  assert.equal(openedDom.body.includes('上次的 job-agent 工作还在吗？'), true);
  assert.equal(openedDom.body.includes('private-session-id'), false);
  assert.equal(openedDom.body.includes('/private/account-7'), false);

  await window.webContents.executeJavaScript(
    "document.querySelector('.conversation-back').click()",
  );
  await waitFor(() => window.webContents.executeJavaScript(
    "document.querySelector('[data-open-conversation=\"job-agent\"]') !== null",
  ));
  window.webContents.send('conversation:state', {
    ...conversationState('job-agent', [
      { id: 'message-1', role: 'assistant', text: '后台更新不应抢走当前页面。' },
    ]),
    streaming: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await window.webContents.executeJavaScript(
    "document.querySelector('[data-open-conversation=\"job-agent\"]') !== null",
  ), true);
  await window.webContents.executeJavaScript(
    "document.getElementById('nav-conversation').click()",
  );

  await window.webContents.executeJavaScript(`
    (() => {
      const form = document.getElementById('conversation-form');
      form.elements.message.value = '继续匹配这份 JD';
      form.requestSubmit();
    })()
  `);
  await waitFor(() => prompts.length === 1);
  await waitFor(() => window.webContents.executeJavaScript(
    "document.body.innerText.includes('已继续分析。')",
  ));
  assert.deepEqual(prompts, ['继续匹配这份 JD']);

  currentConversation = {
    ...currentConversation,
    streaming: true,
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
    optionCount: document.querySelectorAll('[data-permission-option]').length,
    hasPermanentChoice: document.body.innerText.includes('永久允许'),
  })`);
  assert.equal(permissionDom.body.includes('Run the verified deploy command'), true);
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
  await waitFor(() => opens.length === 3);
  assert.deepEqual(opens, ['future-agent', 'job-agent', 'job-agent']);
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
        desiredState: 'stopped',
        runtimeState: 'available',
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
    streaming: false,
    transcriptTruncated: false,
    error: null,
    stopReason: 'end_turn',
  };
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('等待对话 UI 超时');
}
